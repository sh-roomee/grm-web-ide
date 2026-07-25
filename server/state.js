import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * grmide가 저장소별로 들고 있어야 하는 상태.
 *
 * 지금은 리뷰 코멘트를 담는다. 코멘트는 "이 줄 왜 이렇게 했어?"를 적어 두고
 * AI에게 넘기기 위한 것이므로, 새로고침이나 grmide 재시작에 사라지면 안 된다.
 *
 * 왜 `.git` 안인가:
 *  - 워킹트리에 파일을 만들면 grmide 자신의 변경 목록에 뜨고 커밋 대상이 된다.
 *    리뷰 메모가 저장소 히스토리에 들어갈 이유는 없다.
 *  - 저장소마다 따로 남아야 한다. 브라우저 localStorage는 포트가 바뀌면(4317이
 *    쓰이는 중이면 4318로 뜬다) 다른 origin이 되어 내용을 잃는다.
 *  - 감시자가 `.git`을 보지 않으므로 저장할 때 화면이 새로고침되지 않는다.
 */

const FILE_NAME = 'grmide-state.json'
// 명령 이름이 gitshow였을 때 쓰던 파일. 리뷰 메모를 잃지 않도록 한 번 옮겨 온다.
const LEGACY_FILE_NAME = 'gitshow-state.json'
const MAX_COMMENTS = 500

const emptyState = () => ({ version: 1, comments: [] })

function statePath(gitDir) {
  return path.join(gitDir, FILE_NAME)
}

/** 옛 이름의 상태 파일이 있고 새 파일이 없으면 옮긴다. */
async function migrateLegacy(gitDir) {
  const target = statePath(gitDir)
  try {
    await fs.access(target)
    return // 새 파일이 이미 있다
  } catch {
    // 계속
  }
  try {
    await fs.rename(path.join(gitDir, LEGACY_FILE_NAME), target)
  } catch {
    // 옛 파일도 없으면 할 일이 없다
  }
}

export async function readState(gitDir) {
  await migrateLegacy(gitDir)
  try {
    const raw = await fs.readFile(statePath(gitDir), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...emptyState(), ...parsed, comments: parsed.comments ?? [] }
  } catch {
    // 없거나 깨졌으면 빈 상태로 시작한다. 리뷰 메모 때문에 도구가 멈추면 안 된다.
    return emptyState()
  }
}

async function writeState(gitDir, state) {
  const target = statePath(gitDir)
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, target) // 쓰다 죽어도 반쪽 파일이 남지 않게
}

/**
 * 코멘트를 추가한다.
 *
 * `code`(그 줄의 내용)를 함께 저장한다. 나중에 프롬프트로 뽑을 때 파일을 다시
 * 읽지 않아도 되고, 그 사이 파일이 바뀌어도 "무엇을 보고 쓴 코멘트인지"가 남는다.
 */
export async function addComment(gitDir, { path: filePath, line, endLine, side, code, text, sha }) {
  const state = await readState(gitDir)
  const comment = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    path: filePath,
    line: Number(line) || null,
    // 여러 줄을 끌어 고른 코멘트. 한 줄이면 null이다.
    endLine: Number(endLine) || null,
    side: side === 'left' ? 'left' : 'right',
    code: typeof code === 'string' ? code.slice(0, 500) : '',
    text: String(text).slice(0, 2000),
    sha: sha ?? null,
    createdAt: new Date().toISOString(),
  }
  state.comments.push(comment)
  // 오래된 것부터 버린다. 무한정 쌓이면 파일과 화면이 무거워진다.
  if (state.comments.length > MAX_COMMENTS) {
    state.comments = state.comments.slice(-MAX_COMMENTS)
  }
  await writeState(gitDir, state)
  return comment
}

export async function updateComment(gitDir, id, text) {
  const state = await readState(gitDir)
  const found = state.comments.find((c) => c.id === id)
  if (!found) return null
  found.text = String(text).slice(0, 2000)
  await writeState(gitDir, state)
  return found
}

export async function removeComment(gitDir, id) {
  const state = await readState(gitDir)
  const before = state.comments.length
  state.comments = state.comments.filter((c) => c.id !== id)
  if (state.comments.length === before) return false
  await writeState(gitDir, state)
  return true
}

export async function clearComments(gitDir) {
  const state = await readState(gitDir)
  state.comments = []
  await writeState(gitDir, state)
}

/**
 * 코멘트를 AI에게 붙여넣을 프롬프트로 만든다.
 *
 * 이 도구의 존재 이유에 가장 가까운 함수다. 지금까지 사람은 브라우저에서 diff를
 * 보고 경로와 줄 번호를 머릿속에 담아 터미널에 다시 타이핑해야 했다.
 *
 * 형식은 파일별로 묶고 코드 블록에 언어를 붙인다 — AI가 위치를 정확히 찾는 데
 * 필요한 정보는 경로·줄 번호·그때 본 코드, 이 셋이다.
 */
export function buildPrompt(comments, { language = 'text' } = {}) {
  if (!comments.length) return ''

  const byPath = new Map()
  for (const comment of comments) {
    if (!byPath.has(comment.path)) byPath.set(comment.path, [])
    byPath.get(comment.path).push(comment)
  }

  const out = ['아래 리뷰 코멘트를 반영해줘.', '']

  for (const [filePath, list] of byPath) {
    list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    out.push(`## ${filePath}`)
    for (const comment of list) {
      const where = lineLabel(filePath, comment)
      out.push('')
      out.push(`### ${where}`)
      if (comment.code.trim()) {
        out.push('```' + languageFor(filePath, language))
        out.push(comment.code)
        out.push('```')
      }
      out.push(comment.text)
    }
    out.push('')
  }

  return out.join('\n').trimEnd() + '\n'
}

/** `path:12` 또는 `path:12-18`. AI가 위치를 찾는 데 쓰는 표기다. */
function lineLabel(filePath, comment) {
  if (!comment.line) return filePath
  const end = comment.endLine && comment.endLine > comment.line ? `-${comment.endLine}` : ''
  return `${filePath}:${comment.line}${end}`
}

const EXT_FENCE = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.css': 'css',
  '.scss': 'scss',
  '.json': 'json',
  '.md': 'md',
  '.html': 'html',
  '.py': 'python',
  '.go': 'go',
  '.sh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
}

function languageFor(filePath, fallback) {
  return EXT_FENCE[path.extname(filePath).toLowerCase()] ?? fallback
}

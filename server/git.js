import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  LOG_FORMAT,
  REF_FORMAT,
  parseLog,
  parseRefList,
  computeLanes,
  flatLanes,
  mergeFileStats,
} from './log.js'

const execFileAsync = promisify(execFile)

// diff 텍스트는 파일 하나에도 수 MB가 될 수 있어 넉넉히 잡는다.
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * git 명령을 실행한다. 사용자 입력은 항상 인자 배열로만 전달되며
 * 셸을 거치지 않으므로 경로에 공백/특수문자가 있어도 안전하다.
 */
export async function git(cwd, args, { allowFail = false, env = null } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    return stdout
  } catch (err) {
    if (allowFail) return err.stdout ?? ''
    const detail = (err.stderr || err.message || '').trim()
    throw new Error(`git ${args.join(' ')} 실패: ${detail}`)
  }
}

/** cwd가 속한 워크트리 루트를 찾는다. git 저장소가 아니면 null. */
export async function resolveRepoRoot(cwd) {
  try {
    const out = await git(cwd, ['rev-parse', '--show-toplevel'])
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * 현재 브랜치 이름. detached HEAD면 짧은 커밋 해시를 반환한다.
 *
 * `rev-parse --abbrev-ref HEAD` 를 쓰지 않는다. 그 경로(`shorten_unambiguous_ref`)는
 * 이름을 **29바이트에서 자르고**, 한글 브랜치는 글자 중간이 잘려 깨진 문자로 끝난다
 * (Apple Git 2.39.5 에서 확인: `feature/GRMWEB3-1639-다인-…` → `…다인-\uFFFD`).
 * `branch --show-current` 는 전체 이름을 그대로 준다.
 */
export async function currentBranch(repo) {
  const shown = (await git(repo, ['branch', '--show-current'], { allowFail: true })).trim()
  if (shown) return shown

  // git 2.22 미만이면 --show-current 가 없다. 그때만 옛 경로로 떨어진다.
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).trim()
  if (branch && branch !== 'HEAD') return branch
  const sha = (await git(repo, ['rev-parse', '--short', 'HEAD'], { allowFail: true })).trim()
  return sha ? `(detached ${sha})` : '(empty)'
}

const STATUS_LABEL = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflicted',
  '?': 'untracked',
  '!': 'ignored',
}

function statusLabel(code) {
  return STATUS_LABEL[code] ?? 'unknown'
}

/**
 * `git status --porcelain -z` 출력을 파싱한다.
 *
 * -z 모드에서는 각 엔트리가 NUL로 끝나고, rename/copy는 새 경로 다음에
 * 원본 경로가 별도 엔트리로 이어서 온다. 이 때문에 split만으로는 처리할 수
 * 없고 순차적으로 소비해야 한다.
 */
function parsePorcelain(raw) {
  const parts = raw.split('\0')
  const entries = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    const index = entry[0]
    const worktree = entry[1]
    const path = entry.slice(3)
    let origPath = null
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      origPath = parts[++i] ?? null
    }
    entries.push({ index, worktree, path, origPath })
  }
  return entries
}

/** `git diff --numstat -z` → { path: {additions, deletions} } */
async function numstat(repo, args) {
  const raw = await git(repo, ['diff', '--numstat', '-z', ...args], { allowFail: true })
  const parts = raw.split('\0')
  const map = new Map()
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i])
    if (!m) continue
    const [, add, del, tail] = m
    // rename인 경우 경로가 비어 있고 원본/대상 경로가 뒤따르는 엔트리로 온다.
    const path = tail === '' ? (parts[i + 2] ?? '') : tail
    if (tail === '') i += 2
    map.set(path, {
      additions: add === '-' ? null : Number(add),
      deletions: del === '-' ? null : Number(del),
    })
  }
  return map
}

/**
 * untracked 파일의 추가 줄 수를 센다. 바이너리는 null.
 *
 * 줄 수를 셀 수 없을 때 그냥 "바이너리"라고 하면 거짓말이 되는 경우가 있다 —
 * **심볼릭 링크**다. worktree 안의 `.claude -> ../.claude` 처럼 도구가 만든 링크가
 * 변경 목록에 매번 뜨는데, "바이너리 파일"로 보이면 무엇인지 알 수 없다.
 * 링크면 가리키는 곳을 함께 돌려준다.
 */
async function untrackedStat(repo, relPath) {
  const raw = await git(repo, ['diff', '--numstat', '--no-index', '--', '/dev/null', relPath], {
    allowFail: true,
  })
  const m = /^(\d+|-)\t/.exec(raw)
  if (m) return { additions: m[1] === '-' ? null : Number(m[1]), deletions: 0 }

  // 셀 수 없었다. 링크라서 그런 것인지 확인한다.
  try {
    const stat = await fs.lstat(path.resolve(repo, relPath))
    if (stat.isSymbolicLink()) {
      return { additions: null, deletions: 0, link: await fs.readlink(path.resolve(repo, relPath)) }
    }
  } catch {
    // 확인 못 하면 그냥 셀 수 없는 것으로 둔다
  }
  return { additions: null, deletions: 0 }
}

/**
 * 워킹트리 상태를 staged / unstaged 두 목록으로 반환한다.
 * 한 파일이 양쪽에 모두 존재할 수 있다(일부만 stage된 경우).
 */
export async function status(repo) {
  const [raw, stagedStat, unstagedStat] = await Promise.all([
    git(repo, ['status', '--porcelain', '-z', '--untracked-files=all']),
    numstat(repo, ['--cached']),
    numstat(repo, []),
  ])

  const staged = []
  const unstaged = []
  const conflicted = []

  for (const { index, worktree, path, origPath } of parsePorcelain(raw)) {
    const isConflict = index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')
    if (isConflict) {
      conflicted.push({ path, origPath, status: 'conflicted', staged: false, additions: null, deletions: null })
      continue
    }
    if (index !== ' ' && index !== '?') {
      staged.push({
        path,
        origPath,
        status: statusLabel(index),
        staged: true,
        ...(stagedStat.get(path) ?? { additions: null, deletions: null }),
      })
    }
    if (worktree !== ' ') {
      const untracked = worktree === '?'
      unstaged.push({
        path,
        origPath,
        status: statusLabel(worktree),
        staged: false,
        untracked,
        ...(untracked
          ? await untrackedStat(repo, path)
          : unstagedStat.get(path) ?? { additions: null, deletions: null }),
      })
    }
  }

  return { staged, unstaged, conflicted }
}

/**
 * 파일 하나의 unified diff 텍스트를 얻는다.
 * untracked 파일은 비교 대상이 없으므로 --no-index로 /dev/null과 비교한다.
 */
export async function fileDiff(repo, path, { staged = false, untracked = false, context = 3 } = {}) {
  const ctx = `-U${Number.isInteger(context) ? context : 3}`
  if (untracked) {
    return git(repo, ['diff', '--no-color', ctx, '--no-index', '--', '/dev/null', path], {
      allowFail: true,
    })
  }
  const args = ['diff', '--no-color', ctx]
  if (staged) args.push('--cached')
  args.push('--', path)
  return git(repo, args, { allowFail: true })
}

/** HEAD 커밋 요약. 저장소에 커밋이 없으면 null. */
export async function headCommit(repo) {
  const out = (
    await git(repo, ['log', '-1', '--pretty=format:%H%x00%h%x00%an%x00%ar%x00%s'], { allowFail: true })
  ).trim()
  if (!out) return null
  const [sha, shortSha, author, relativeDate, subject] = out.split('\0')
  return { sha, shortSha, author, relativeDate, subject }
}

/** 커밋에 부모가 있는지. 최초 커밋은 diff 대상이 달라진다. */
async function hasParent(repo, sha) {
  const out = await git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^1`], { allowFail: true })
  return out.trim() !== ''
}

/**
 * 커밋 목록. 그래프 레인은 log.js가 계산한다.
 *
 * `--topo-order`를 쓴다. 기본(시간순)은 시계가 어긋난 커밋에서 그래프가
 * 꼬여 보인다.
 */
/** 검색 조건을 git 인자로 바꾼다. 사용자 입력은 인자 하나 안에 갇힌다. */
function searchArgs(query, searchIn) {
  if (!query) return []
  switch (searchIn) {
    case 'author':
      return [`--author=${query}`, '--regexp-ignore-case']
    case 'content':
      // pickaxe: 이 문자열이 나타난/사라진 커밋. "이 함수 누가 언제 지웠나"
      return [`-S${query}`, '--pickaxe-all']
    case 'path':
      return ['--', query]
    default:
      return [`--grep=${query}`, '--regexp-ignore-case']
  }
}

export async function commitLog(
  repo,
  { limit = 100, skip = 0, all = true, ref = null, query = '', searchIn = 'message' } = {},
) {
  const search = searchArgs(query, searchIn)
  // `-- <경로>` 는 반드시 맨 뒤로 가야 한다
  const pathspec = searchIn === 'path' && query ? search : []
  const filters = searchIn === 'path' ? [] : search

  const raw = await git(
    repo,
    [
      'log',
      '--topo-order',
      // ref를 고르면 그 브랜치만. 아니면 모든 브랜치가 기본이다. `git log`처럼
      // HEAD 조상만 보면 다른 브랜치가 통째로 사라져서, 브랜치 그림을 보려고
      // 이 화면을 여는 사람에게는 쓸모가 없다.
      ...(ref ? [ref] : all ? ['--all'] : []),
      ...filters,
      `--format=${LOG_FORMAT}`,
      `--max-count=${limit + 1}`, // 한 개 더 받아 다음 페이지가 있는지 본다
      `--skip=${skip}`,
      ...pathspec,
    ],
    { allowFail: true },
  )
  const parsed = parseLog(raw)
  const hasMore = parsed.length > limit
  const page = parsed.slice(0, limit)

  // 검색 결과는 위상이 끊겨 있어 그래프가 거짓이 된다
  const filtered = Boolean(query)
  const { commits, laneCount } = filtered ? flatLanes(page) : computeLanes(page)
  return { commits, laneCount, hasMore, skip, limit, filtered, ref: ref ?? null }
}

/** 로컬 브랜치 · 원격 브랜치 · 태그 목록. 최근 커밋 순. */
export async function refList(repo) {
  const raw = await git(
    repo,
    ['for-each-ref', '--sort=-committerdate', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'],
    { allowFail: true },
  )
  return parseRefList(raw)
}

/**
 * 사용자가 보낸 ref 이름을 그대로 git에 넘겨도 되는지 확인한다.
 *
 * 이 값은 리비전 자리에 들어가므로 `--all`이나 `-S...` 같은 옵션으로 해석되면
 * 안 된다. 그래서 `-`로 시작하는 것을 먼저 막고, 실제로 존재하는 ref인지까지
 * 확인한다.
 */
export async function resolveRef(repo, name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) return null
  const out = await git(repo, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], {
    allowFail: true,
  })
  return out.trim() ? name : null
}

/** 커밋 하나의 메타와 바뀐 파일 목록. 병합 커밋은 첫 부모와 비교한다. */
export async function commitDetail(repo, sha) {
  const metaRaw = await git(repo, ['log', '-1', `--format=${LOG_FORMAT}`, sha])
  const [meta] = parseLog(metaRaw)
  if (!meta) throw Object.assign(new Error('커밋을 찾을 수 없습니다'), { status: 404 })

  const body = await git(repo, ['log', '-1', '--format=%b', sha], { allowFail: true })
  const rooted = !(await hasParent(repo, sha))

  // 최초 커밋은 비교 대상이 없어 --root로 트리 전체를 낸다
  const args = rooted
    ? ['diff-tree', '--root', '-r', '-M', '--no-commit-id', sha]
    : ['diff-tree', '-r', '-M', '--no-commit-id', `${sha}^1`, sha]

  const [numstat, nameStatus] = await Promise.all([
    git(repo, [...args, '--numstat'], { allowFail: true }),
    git(repo, [...args, '--name-status'], { allowFail: true }),
  ])

  return { ...meta, body: body.trim(), rooted, files: mergeFileStats(numstat, nameStatus) }
}

/** 커밋 안에서 파일 하나의 diff. */
export async function commitFileDiff(repo, sha, path, { context = 3 } = {}) {
  const ctx = `-U${Number.isInteger(context) ? context : 3}`
  if (await hasParent(repo, sha)) {
    // 병합 커밋에서도 첫 부모와 비교한다(combined diff는 읽기 어렵다)
    return git(repo, ['diff', '--no-color', ctx, `${sha}^1`, sha, '--', path], { allowFail: true })
  }
  return git(repo, ['show', '--no-color', ctx, '--format=', sha, '--', path], { allowFail: true })
}

// ---------------------------------------------------------------------------
// 기준점 (baseline) — "내가 마지막으로 확인한 시점"
//
// git에는 HEAD와 index만 있고 "리뷰 시점"이라는 개념이 없다. AI가 계속 고치는
// 동안 `git diff`는 매번 전체를 다시 보여주고, 이미 본 40개 파일과 새로 바뀐
// 3개가 구분되지 않는다.
//
// 그래서 현재 워킹트리를 트리 객체로 굳혀 ref에 매달아 둔다. 그 뒤로는
// "기준점 트리 vs 지금 워킹트리"를 비교하면 새로 바뀐 것만 나온다.
// ---------------------------------------------------------------------------

const BASELINE_REF = 'refs/grmide/baseline'
// 명령 이름이 gitshow였을 때 쓰던 ref. 기준점을 잃지 않도록 한 번 옮겨 온다.
const LEGACY_BASELINE_REF = 'refs/gitshow/baseline'

/**
 * 워킹트리 전체를 트리 객체로 만든다.
 *
 * 사용자의 index를 건드리면 안 되므로 별도 index 파일을 쓴다. 매번 새로 만들지
 * 않고 `.git` 안에 두고 재사용하는 이유는 git의 stat 캐시다 — 빈 index로
 * 시작하면 저장소 전체를 다시 해시한다.
 *
 * `git add -A`라서 untracked 파일도 담기고 `.gitignore`는 지켜진다.
 */
async function currentTree(repo, gitDir) {
  const env = { GIT_INDEX_FILE: path.join(gitDir, 'grmide-index') }
  await git(repo, ['add', '-A'], { env })
  return (await git(repo, ['write-tree'], { env })).trim()
}

export async function resolveGitDir(repo) {
  return (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim()
}

/** 지금 상태를 기준점으로 잡는다. ref에 매달아 두므로 gc에도 살아남는다. */
export async function setBaseline(repo, gitDir) {
  const tree = await currentTree(repo, gitDir)
  await git(repo, ['update-ref', BASELINE_REF, tree])
  return tree
}

export async function getBaseline(repo) {
  const out = await git(repo, ['rev-parse', '--verify', '--quiet', BASELINE_REF], {
    allowFail: true,
  })
  if (out.trim()) return out.trim()

  // 옛 이름(gitshow)으로 잡아 둔 기준점이 있으면 옮겨 온다
  const legacy = (
    await git(repo, ['rev-parse', '--verify', '--quiet', LEGACY_BASELINE_REF], { allowFail: true })
  ).trim()
  if (!legacy) return null
  await git(repo, ['update-ref', BASELINE_REF, legacy], { allowFail: true })
  await git(repo, ['update-ref', '-d', LEGACY_BASELINE_REF], { allowFail: true })
  return legacy
}

export async function clearBaseline(repo) {
  await git(repo, ['update-ref', '-d', BASELINE_REF], { allowFail: true })
}

/**
 * 기준점 이후 바뀐 파일 경로.
 *
 * `git diff <tree>`로는 untracked 파일이 빠진다(index에 없는 경로는 비교 대상이
 * 아니다). 그래서 지금 워킹트리도 트리로 만들어 트리끼리 비교한다.
 */
export async function changedSinceBaseline(repo, gitDir, baseTree) {
  if (!baseTree) return null
  const cur = await currentTree(repo, gitDir)
  if (cur === baseTree) return new Set()
  const raw = await git(repo, ['diff-tree', '-r', '--name-only', '-z', baseTree, cur], {
    allowFail: true,
  })
  return new Set(raw.split('\0').filter(Boolean))
}

/**
 * 워킹트리 전체의 변경을 한 번에 받는다. 위험 신호 분석에 쓴다.
 *
 * 파일마다 `git diff`를 돌리면 44개 파일에 44번 프로세스를 띄운다. 기준점이 쓰는
 * 임시 index를 그대로 재사용해 `add -A` → `diff HEAD --cached` 로 한 번에 받는다.
 * 이러면 추적되지 않은 새 파일의 내용도 함께 들어온다.
 *
 * `-U0`: 컨텍스트 줄은 필요 없다. 추가·삭제된 줄만 본다.
 */
export async function worktreeDiff(repo, gitDir) {
  const env = { GIT_INDEX_FILE: path.join(gitDir, 'grmide-index') }
  await git(repo, ['add', '-A'], { env })
  return git(repo, ['diff', '--no-color', '-U0', '--cached', 'HEAD'], { env, allowFail: true })
}

/** 기준점 이후 이 파일이 어떻게 바뀌었는지. */
export async function baselineFileDiff(repo, gitDir, relPath, { context = 3 } = {}) {
  const base = await getBaseline(repo)
  if (!base) return ''
  const cur = await currentTree(repo, gitDir)
  const ctx = `-U${Number.isInteger(context) ? context : 3}`
  return git(repo, ['diff-tree', '-p', '--no-color', ctx, base, cur, '--', relPath], {
    allowFail: true,
  })
}

/**
 * git이 아는 파일 목록. 추적 중인 파일 + untracked 파일.
 *
 * 파일시스템을 직접 훑지 않는 이유: `.gitignore`를 git이 알아서 반영해 주고
 * (`node_modules`가 목록을 덮지 않는다), 이 도구의 범위가 "git이 보는 것"이다.
 */
export async function listFiles(repo) {
  const raw = await git(repo, ['ls-files', '-co', '--exclude-standard', '-z'], { allowFail: true })
  return raw.split('\0').filter(Boolean)
}

/**
 * 저장소 전체 텍스트 검색 (⌘⇧F).
 *
 * `git grep`을 쓰는 이유: `.gitignore`를 알아서 지키고(`node_modules`가 결과를
 * 덮지 않는다), 추적 중인 파일만 훑어 빠르다.
 *
 * 정규식이 아니라 고정 문자열(`-F`)이다. 코드에서 찾는 문자열은 대부분 특수문자를
 * 포함하고, 타이핑 중간 상태(`(`, `[a-`)가 늘 오류가 되기 때문이다.
 */
export async function grep(repo, query, { limit = 400 } = {}) {
  if (!query) return { hits: [], truncated: false }

  const raw = await git(
    repo,
    [
      'grep',
      '--null', // path\0line\0text — 경로에 콜론이 있어도 안전하다
      '-n',
      '-I', // 바이너리 파일 건너뛰기
      '-i',
      '-F',
      // 추적되지 않은 파일도 본다. AI가 방금 만든 파일이 검색에서 빠지면
      // 이 도구를 쓰는 상황에서 가장 자주 찾을 것을 못 찾는다.
      // .gitignore는 그대로 지켜진다(node_modules는 안 들어온다).
      '--untracked',
      '-e',
      query,
      '--',
      '.',
    ],
    { allowFail: true }, // 결과가 없으면 exit 1이다
  )

  const hits = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const [path, lineNo, ...rest] = line.split('\0')
    if (!path || !lineNo) continue
    if (hits.length >= limit) return { hits, truncated: true }
    hits.push({ path, line: Number(lineNo), text: rest.join('\0').slice(0, 400) })
  }
  return { hits, truncated: false }
}

const BINARY_SNIFF_BYTES = 8000

/**
 * 파일 내용을 줄 배열로 읽는다. 커밋을 지정하면 그 시점의 내용을 읽는다.
 * 편집은 하지 않으므로 읽기 전용이다.
 */
/**
 * 미리보기용 원본 바이트.
 *
 * 이미지를 보여주려면 텍스트로 디코딩하면 안 되므로 buffer로 받는다. `rev`가
 * null이면 워킹트리 파일을 그대로 읽고, 그 밖에는 git 객체에서 꺼낸다
 * (`:path`는 index, `HEAD:path`는 커밋된 내용).
 *
 * 없는 blob(추가된 파일의 '이전', 지워진 파일의 '이후')은 예외가 아니라 null이다 —
 * 한쪽만 있는 것이 정상 상태다.
 */
export async function readBlob(repo, relPath, { rev = null, maxBytes = 0 } = {}) {
  let buffer
  if (rev === null) {
    try {
      buffer = await fs.readFile(path.resolve(repo, relPath))
    } catch {
      return null
    }
  } else {
    try {
      buffer = await execFileAsync('git', ['show', `${rev}:${relPath}`], {
        cwd: repo,
        maxBuffer: MAX_BUFFER,
        encoding: 'buffer',
      }).then((r) => r.stdout)
    } catch {
      return null
    }
  }
  if (maxBytes && buffer.length > maxBytes) return { tooLarge: true, size: buffer.length }
  return { buffer, size: buffer.length }
}

/** 미리보기 크기만 알아본다. 내용을 읽지 않으므로 큰 파일에도 싸다. */
export async function blobSize(repo, relPath, { rev = null } = {}) {
  if (rev === null) {
    try {
      const stat = await fs.stat(path.resolve(repo, relPath))
      return stat.isFile() ? stat.size : null
    } catch {
      return null
    }
  }
  const out = await git(repo, ['cat-file', '-s', `${rev}:${relPath}`], { allowFail: true })
  const size = Number.parseInt(out.trim(), 10)
  return Number.isFinite(size) ? size : null
}

/** 기준점 ref 이름. 미리보기가 "기준점 대비"를 읽을 때 쓴다. */
export const baselineRef = () => BASELINE_REF

export async function fileContent(repo, relPath, { sha = null, maxLines = 20000 } = {}) {
  let buffer
  if (sha) {
    buffer = await execFileAsync('git', ['show', `${sha}:${relPath}`], {
      cwd: repo,
      maxBuffer: MAX_BUFFER,
      encoding: 'buffer',
    }).then((r) => r.stdout)
  } else {
    buffer = await fs.readFile(path.resolve(repo, relPath))
  }

  // NUL이 섞여 있으면 바이너리로 본다. git이 쓰는 것과 같은 어림짐작이다.
  const head = buffer.subarray(0, BINARY_SNIFF_BYTES)
  if (head.includes(0)) return { binary: true, lines: [], truncated: false }

  const text = buffer.toString('utf8')
  const all = text.split('\n')
  // 마지막 개행 때문에 생긴 빈 줄은 버린다
  if (all.length && all[all.length - 1] === '') all.pop()

  return {
    binary: false,
    lines: all.slice(0, maxLines),
    truncated: all.length > maxLines,
    lineCount: all.length,
  }
}

export async function stageFile(repo, path) {
  await git(repo, ['add', '--', path])
}

export async function unstageFile(repo, path) {
  await git(repo, ['reset', '-q', 'HEAD', '--', path])
}

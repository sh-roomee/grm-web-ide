import { execFile } from 'node:child_process'
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
export async function git(cwd, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
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

/** 현재 브랜치 이름. detached HEAD면 짧은 커밋 해시를 반환한다. */
export async function currentBranch(repo) {
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

/** untracked 파일의 추가 줄 수를 센다. 바이너리는 null. */
async function untrackedStat(repo, path) {
  const raw = await git(repo, ['diff', '--numstat', '--no-index', '--', '/dev/null', path], {
    allowFail: true,
  })
  const m = /^(\d+|-)\t/.exec(raw)
  if (!m) return { additions: null, deletions: 0 }
  return { additions: m[1] === '-' ? null : Number(m[1]), deletions: 0 }
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

export async function stageFile(repo, path) {
  await git(repo, ['add', '--', path])
}

export async function unstageFile(repo, path) {
  await git(repo, ['reset', '-q', 'HEAD', '--', path])
}

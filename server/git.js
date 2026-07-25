import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

export async function stageFile(repo, path) {
  await git(repo, ['add', '--', path])
}

export async function unstageFile(repo, path) {
  await git(repo, ['reset', '-q', 'HEAD', '--', path])
}

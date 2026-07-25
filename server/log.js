/**
 * `git log` 출력을 파싱하고, 브랜치 그래프를 그릴 레인(lane)을 계산한다.
 *
 * `git log --graph`의 ASCII 그림이 브랜치 셋만 넘어도 판독 불가해지는 것이
 * 이 도구를 만든 이유 중 하나다. 그래서 ASCII를 그대로 옮기지 않고, 각 커밋이
 * 몇 번째 레인에 있고 어떤 선이 그 행을 지나가는지를 숫자로 내보낸다.
 * 실제 그림은 클라이언트가 SVG로 그린다.
 *
 * 순수 함수만 둔다. git 실행은 git.js가 한다.
 */

// 레코드/필드 구분자. 커밋 제목에는 개행이나 탭이 들어갈 수 있어 제어문자를 쓴다.
// git 쪽에는 %x00 / %x1e 로 넘긴다 — NUL 바이트는 명령행 인자에 직접 넣을 수 없다
// (C 문자열이 거기서 끝나므로 인자가 잘린다).
const RECORD_SEP = '\u001e'
const FIELD_SEP = '\u0000'

export const LOG_FORMAT = [
  '%H', // 전체 해시
  '%h', // 짧은 해시
  '%P', // 부모 해시들 (공백 구분)
  '%an', // 작성자
  '%ae', // 작성자 이메일
  '%ar', // 상대 시각
  '%aI', // ISO 시각
  '%s', // 제목
  '%D', // ref 이름들 (HEAD -> main, tag: v0.1, ...)
].join('%x00') + '%x1e'

/** `%D` 출력을 배열로. `HEAD -> main` 은 브랜치로 취급한다. */
function parseRefs(raw) {
  if (!raw) return []
  return raw
    .split(', ')
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => {
      if (ref.startsWith('tag: ')) return { type: 'tag', name: ref.slice(5) }
      if (ref.startsWith('HEAD -> ')) return { type: 'head', name: ref.slice(8) }
      if (ref === 'HEAD') return { type: 'head', name: 'HEAD' }
      if (ref.startsWith('origin/')) return { type: 'remote', name: ref }
      return { type: 'branch', name: ref }
    })
}

export function parseLog(raw) {
  if (!raw) return []
  return raw
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, shortSha, parents, author, email, relativeDate, isoDate, subject, refs] =
        record.split(FIELD_SEP)
      return {
        sha,
        shortSha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author,
        email,
        relativeDate,
        isoDate,
        subject: subject ?? '',
        refs: parseRefs(refs),
      }
    })
}

/**
 * 각 커밋에 그래프 정보를 붙인다. 커밋 순서(위 → 아래)는 그대로 유지한다.
 *
 * 레인은 "아래로 이어지길 기다리는 선"의 배열이다. 각 칸은 그 선이 다음에
 * 만나야 할 커밋 해시를 들고 있다.
 *
 *  - 커밋을 만나면 그 커밋을 기다리던 레인이 그 커밋의 자리(`lane`)가 된다.
 *  - 기다리는 레인이 없으면(= 아무 자식도 없는 최신 커밋) 빈 레인을 새로 쓴다.
 *  - 그 자리는 첫 부모가 이어받고, 나머지 부모(병합)는 다른 레인으로 갈라진다.
 *
 * 각 행에 붙는 값:
 *  - `lane`        점을 그릴 칸
 *  - `lanesAbove`  이 행 위에서 내려오는 선들이 있는 칸
 *  - `lanesBelow`  이 행 아래로 내려가는 선들이 있는 칸
 *  - `parentLanes` 이 커밋에서 아래로 뻗는 선의 도착 칸 (병합이면 둘 이상)
 */
export function computeLanes(commits) {
  const lanes = [] // index → 기다리는 sha (없으면 null)

  const occupied = () => lanes.map((sha, i) => (sha ? i : -1)).filter((i) => i >= 0)

  const claim = (sha) => {
    const free = lanes.indexOf(null)
    if (free >= 0) {
      lanes[free] = sha
      return free
    }
    lanes.push(sha)
    return lanes.length - 1
  }

  let maxLane = 0

  for (const commit of commits) {
    const lanesAbove = occupied()

    let lane = lanes.indexOf(commit.sha)
    if (lane === -1) lane = claim(commit.sha)

    // 같은 커밋을 기다리던 다른 레인들은 여기서 합쳐지며 사라진다.
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === commit.sha) lanes[i] = null
    }

    const parentLanes = []
    commit.parents.forEach((parent, index) => {
      if (index === 0) {
        lanes[lane] = parent
        parentLanes.push(lane)
        return
      }
      // 이미 그 부모를 기다리는 레인이 있으면 그리로 합친다
      const existing = lanes.indexOf(parent)
      parentLanes.push(existing >= 0 ? existing : claim(parent))
    })

    if (commit.parents.length === 0) lanes[lane] = null // 최초 커밋

    // 꼬리의 빈 레인은 정리해서 그래프 폭이 무한정 늘지 않게 한다
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    commit.lane = lane
    commit.lanesAbove = lanesAbove
    commit.lanesBelow = occupied()
    commit.parentLanes = parentLanes
    commit.isMerge = commit.parents.length > 1

    maxLane = Math.max(maxLane, lane, ...lanesAbove, ...commit.lanesBelow)
  }

  return { commits, laneCount: commits.length ? maxLane + 1 : 0 }
}

/**
 * 검색 결과에는 그래프를 그리지 않는다.
 *
 * 검색으로 걸러낸 목록은 부모가 대부분 빠져 있어서 위상이 끊긴다. 그 상태로
 * 레인을 계산하면 커밋마다 새 레인을 잡아 그래프 폭이 커밋 수만큼 늘어나고,
 * 그려진 선도 사실과 다르다. 그래서 아예 점만 찍는다.
 */
export function flatLanes(commits) {
  for (const commit of commits) {
    commit.lane = 0
    commit.lanesAbove = []
    commit.lanesBelow = []
    commit.parentLanes = []
    commit.isMerge = commit.parents.length > 1
  }
  return { commits, laneCount: 1 }
}

/** `git for-each-ref` 출력을 파싱한다. */
export function parseRefList(raw) {
  const refs = []
  for (const line of (raw ?? '').split(RECORD_SEP)) {
    if (!line.trim()) continue
    const [name, fullName, sha, date, subject, head] = line.trim().split(FIELD_SEP)
    if (!name) continue
    // origin/HEAD 는 다른 브랜치를 가리키는 별칭이라 목록에 넣지 않는다
    if (fullName === 'refs/remotes/origin/HEAD' || name.endsWith('/HEAD')) continue

    const kind = fullName.startsWith('refs/heads/')
      ? 'local'
      : fullName.startsWith('refs/remotes/')
        ? 'remote'
        : 'tag'

    refs.push({
      name,
      fullName,
      kind,
      shortSha: sha,
      relativeDate: date,
      subject: subject ?? '',
      current: head === '*',
    })
  }
  return refs
}

export const REF_FORMAT = [
  '%(refname:short)',
  '%(refname)',
  '%(objectname:short)',
  '%(committerdate:relative)',
  '%(contents:subject)',
  '%(HEAD)',
].join('%00') + '%1e'

/** `git diff-tree --numstat` / `--name-status` 두 출력을 한 목록으로 합친다. */
export function mergeFileStats(numstatRaw, nameStatusRaw) {
  const stats = new Map()
  for (const line of (numstatRaw ?? '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line)
    if (!m) continue
    const [, add, del, pathPart] = m
    // rename은 "old => new" 또는 탭으로 이어진 두 경로로 온다
    const path = pathPart.includes('\t') ? pathPart.split('\t').pop() : pathPart
    stats.set(path, {
      additions: add === '-' ? null : Number(add),
      deletions: del === '-' ? null : Number(del),
    })
  }

  const STATUS = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    T: 'typechange',
  }

  const files = []
  for (const line of (nameStatusRaw ?? '').split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0][0]
    const origPath = parts.length > 2 ? parts[1] : null
    const path = parts.length > 2 ? parts[2] : parts[1]
    if (!path) continue
    files.push({
      path,
      origPath,
      status: STATUS[code] ?? 'modified',
      ...(stats.get(path) ?? { additions: null, deletions: null }),
    })
  }
  return files
}

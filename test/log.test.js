import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseLog,
  computeLanes,
  flatLanes,
  parseRefList,
  mergeFileStats,
  LOG_FORMAT,
  REF_FORMAT,
} from '../server/log.js'

const FS = '\u0000' // 필드 구분자
const RS = '\u001e' // 레코드 구분자

/** git이 내보낼 한 줄을 만든다. */
function record({ sha, parents = '', subject = 's', refs = '' }) {
  return (
    [sha, sha.slice(0, 7), parents, '작성자', 'a@b.c', '2 hours ago', '2026-07-25T10:00:00+09:00', subject, refs].join(FS) + RS
  )
}

test('LOG_FORMAT은 git 이스케이프를 쓴다 (인자에 NUL을 넣을 수 없다)', () => {
  assert.ok(LOG_FORMAT.includes('%x00'), '필드 구분자는 %x00')
  assert.ok(LOG_FORMAT.endsWith('%x1e'), '레코드 구분자는 %x1e')
  assert.ok(!LOG_FORMAT.includes(FS), '실제 NUL 바이트가 들어가면 인자가 잘린다')
})

test('커밋 필드를 파싱한다', () => {
  const raw = record({ sha: 'aaaaaaaaaa', parents: 'bbbbbbbbbb cccccccccc', subject: '제목: 콜론과 공백' })
  const [c] = parseLog(raw)
  assert.equal(c.sha, 'aaaaaaaaaa')
  assert.equal(c.shortSha, 'aaaaaaa')
  assert.deepEqual(c.parents, ['bbbbbbbbbb', 'cccccccccc'])
  assert.equal(c.subject, '제목: 콜론과 공백')
  assert.equal(c.author, '작성자')
})

test('부모가 없는 최초 커밋', () => {
  const [c] = parseLog(record({ sha: 'aaaaaaaaaa' }))
  assert.deepEqual(c.parents, [])
})

test('ref 종류를 구분한다', () => {
  const raw = record({ sha: 'aaaaaaaaaa', refs: 'HEAD -> main, tag: v0.1, origin/main, develop' })
  const [c] = parseLog(raw)
  assert.deepEqual(c.refs, [
    { type: 'head', name: 'main' },
    { type: 'tag', name: 'v0.1' },
    { type: 'remote', name: 'origin/main' },
    { type: 'branch', name: 'develop' },
  ])
})

test('빈 출력은 빈 배열', () => {
  assert.deepEqual(parseLog(''), [])
  assert.deepEqual(parseLog(null), [])
})

/** 레인 계산 테스트용 축약 생성기 */
const commit = (sha, parents = []) => ({ sha, parents })

test('직선 히스토리는 한 레인만 쓴다', () => {
  const { commits, laneCount } = computeLanes([
    commit('c', ['b']),
    commit('b', ['a']),
    commit('a', []),
  ])
  assert.equal(laneCount, 1)
  assert.deepEqual(commits.map((c) => c.lane), [0, 0, 0])
  assert.deepEqual(commits[0].lanesAbove, [], '최신 커밋 위로는 선이 없다')
  assert.deepEqual(commits[2].lanesBelow, [], '최초 커밋 아래로는 선이 없다')
})

test('병합 커밋은 아래로 두 레인으로 갈라진다', () => {
  //   m (merge)
  //   |\
  //   | f
  //   b/
  //   a
  const { commits, laneCount } = computeLanes([
    commit('m', ['b', 'f']),
    commit('f', ['b']),
    commit('b', ['a']),
    commit('a', []),
  ])
  const [m, f, b] = commits

  assert.equal(m.isMerge, true)
  assert.equal(m.lane, 0)
  assert.deepEqual(m.parentLanes, [0, 1], '첫 부모는 제자리, 둘째 부모는 새 레인')
  assert.equal(f.lane, 1)
  assert.equal(b.lane, 0, '두 갈래가 b에서 다시 합쳐진다')
  assert.deepEqual(b.lanesAbove, [0, 1])
  assert.deepEqual(b.lanesBelow, [0], '합쳐진 뒤에는 한 레인만 남는다')
  assert.equal(laneCount, 2)
})

test('통과하는 선과 합쳐지는 선을 구분할 수 있다', () => {
  // 렌더러는 lanesAbove ∩ lanesBelow 를 "통과", 그 차이를 "이 커밋으로 합쳐짐"으로 읽는다
  const { commits } = computeLanes([
    commit('m', ['c', 'f']),
    commit('f', ['b']),
    commit('c', ['b']),
    commit('b', ['a']),
    commit('a', []),
  ])
  const c = commits[2] // 'c'
  assert.ok(c.lanesAbove.includes(1), 'f 레인이 c 행을 지난다')
  assert.ok(c.lanesBelow.includes(1), 'f의 부모(b)를 아직 기다리므로 계속 내려간다')

  const b = commits[3]
  const converging = b.lanesAbove.filter((lane) => !b.lanesBelow.includes(lane))
  assert.ok(converging.length > 0, 'b에서 합쳐지는 레인이 있다')
})

test('갈라진 레인은 재사용된다 (그래프 폭이 무한정 늘지 않는다)', () => {
  const { laneCount } = computeLanes([
    commit('m2', ['m1', 'y']),
    commit('y', ['m1']),
    commit('m1', ['base', 'x']),
    commit('x', ['base']),
    commit('base', []),
  ])
  assert.ok(laneCount <= 2, `레인 두 개로 충분한데 ${laneCount}개를 썼다`)
})

test('빈 목록', () => {
  assert.deepEqual(computeLanes([]), { commits: [], laneCount: 0 })
})

test('flatLanes: 검색 결과는 그래프를 그리지 않는다', () => {
  // 부모가 목록에 없는(위상이 끊긴) 커밋들
  const { commits, laneCount } = flatLanes([
    { sha: 'a', parents: ['zzz'] },
    { sha: 'b', parents: ['yyy', 'xxx'] },
  ])
  assert.equal(laneCount, 1, '폭은 항상 1이다')
  for (const c of commits) {
    assert.equal(c.lane, 0)
    assert.deepEqual(c.lanesAbove, [])
    assert.deepEqual(c.lanesBelow, [])
    assert.deepEqual(c.parentLanes, [], '선을 그리지 않으므로 도착 레인도 없다')
  }
  assert.equal(commits[1].isMerge, true, '병합 여부는 그대로 알려준다')
})

test('flatLanes와 computeLanes의 차이: 끊긴 목록에 레인을 계산하면 폭이 터진다', () => {
  const broken = Array.from({ length: 20 }, (_, i) => ({
    sha: `c${i}`,
    parents: [`missing${i}`], // 부모가 목록에 없다
  }))
  const computed = computeLanes(broken.map((c) => ({ ...c })))
  const flat = flatLanes(broken.map((c) => ({ ...c })))
  assert.ok(computed.laneCount > 5, '끊긴 목록은 레인이 계속 늘어난다')
  assert.equal(flat.laneCount, 1)
})

test('parseRefList: 로컬/원격/태그를 구분하고 현재 브랜치를 표시한다', () => {
  const raw = [
    ['main', 'refs/heads/main', 'abc1234', '2 hours ago', '제목', '*'].join(FS),
    ['feature', 'refs/heads/feature', 'def5678', '3 days ago', '기능', ''].join(FS),
    ['origin/main', 'refs/remotes/origin/main', 'abc1234', '2 hours ago', '제목', ''].join(FS),
    ['v0.1', 'refs/tags/v0.1', 'aaa1111', '1 week ago', '릴리스', ''].join(FS),
  ].join(RS)

  const refs = parseRefList(raw)
  assert.deepEqual(
    refs.map((r) => [r.name, r.kind, r.current]),
    [
      ['main', 'local', true],
      ['feature', 'local', false],
      ['origin/main', 'remote', false],
      ['v0.1', 'tag', false],
    ],
  )
  assert.equal(refs[0].shortSha, 'abc1234')
  assert.equal(refs[0].relativeDate, '2 hours ago')
})

test('parseRefList: origin/HEAD는 별칭이라 제외한다', () => {
  const raw = [
    ['origin/HEAD', 'refs/remotes/origin/HEAD', 'abc1234', '2 hours ago', '', ''].join(FS),
    ['origin/main', 'refs/remotes/origin/main', 'abc1234', '2 hours ago', '', ''].join(FS),
  ].join(RS)
  assert.deepEqual(parseRefList(raw).map((r) => r.name), ['origin/main'])
})

test('parseRefList: 빈 입력', () => {
  assert.deepEqual(parseRefList(''), [])
  assert.deepEqual(parseRefList(null), [])
})

test('REF_FORMAT도 git 이스케이프를 쓴다', () => {
  assert.ok(REF_FORMAT.includes('%00'))
  assert.ok(REF_FORMAT.includes('%(HEAD)'), '현재 브랜치 표시가 필요하다')
  assert.ok(!REF_FORMAT.includes(FS))
})

test('mergeFileStats: numstat과 name-status를 합친다', () => {
  const numstat = '5\t2\tsrc/a.js\n0\t9\tsrc/b.js\n-\t-\tlogo.png'
  const nameStatus = 'M\tsrc/a.js\nD\tsrc/b.js\nA\tlogo.png'
  assert.deepEqual(mergeFileStats(numstat, nameStatus), [
    { path: 'src/a.js', origPath: null, status: 'modified', additions: 5, deletions: 2 },
    { path: 'src/b.js', origPath: null, status: 'deleted', additions: 0, deletions: 9 },
    { path: 'logo.png', origPath: null, status: 'added', additions: null, deletions: null },
  ])
})

test('mergeFileStats: rename은 원래 경로를 함께 담는다', () => {
  const numstat = '1\t1\tsrc/old.js\tsrc/new.js'
  const nameStatus = 'R100\tsrc/old.js\tsrc/new.js'
  const [file] = mergeFileStats(numstat, nameStatus)
  assert.equal(file.status, 'renamed')
  assert.equal(file.path, 'src/new.js')
  assert.equal(file.origPath, 'src/old.js')
  assert.equal(file.additions, 1)
})

test('mergeFileStats: 빈 입력', () => {
  assert.deepEqual(mergeFileStats('', ''), [])
  assert.deepEqual(mergeFileStats(null, null), [])
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import * as gitApi from '../server/git.js'

/**
 * 확인 시점(`refs/grmide/seen`) — "내가 이 파일을 읽은 뒤 무엇이 더 바뀌었나".
 *
 * 이 기능은 전부 git 플럼빙이다(임시 index · write-tree · diff-tree). 순수 함수가
 * 아니라 실제 저장소가 있어야 검증되고, 틀렸을 때의 증상이 "diff가 조금 이상하다"라서
 * 눈으로는 놓친다. 그래서 `test/`의 첫 통합 테스트로 둔다.
 */

let repo
let gitDir

/** 커밋은 저장소 밖 설정에 기대지 않게 매번 신원을 넘긴다. */
const commit = (message) =>
  gitApi.git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message])

const write = (rel, text) => fs.writeFile(path.join(repo, rel), text)

before(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'grmide-seen-'))
  await gitApi.git(repo, ['init', '-q', '-b', 'main'])
  await write('a.txt', 'alpha\nbravo\ncharlie\n')
  await write('b.txt', 'one\ntwo\n')
  await gitApi.git(repo, ['add', '-A'])
  await commit('init')
  gitDir = await gitApi.resolveGitDir(repo)
})

after(async () => {
  if (repo) await fs.rm(repo, { recursive: true, force: true })
})

describe('확인 시점 스냅샷', () => {
  test('스냅샷이 없으면 null이다 (빈 문자열이 아니다)', async () => {
    // 빈 문자열은 "바뀐 것이 없다"는 뜻이라 구별해야 한다. 부르는 쪽이 HEAD로
    // 떨어뜨릴지 판단할 근거가 된다.
    assert.equal(await gitApi.getSeen(repo), null)
    assert.equal(await gitApi.seenFileDiff(repo, gitDir, 'a.txt'), null)
  })

  test('확인한 뒤 바뀐 것만 나온다', async () => {
    await write('a.txt', 'alpha AI-1\nbravo\ncharlie\n')
    await gitApi.markSeen(repo, gitDir, 'a.txt')

    // 확인한 직후에는 바뀐 것이 없다
    assert.equal((await gitApi.seenFileDiff(repo, gitDir, 'a.txt')).trim(), '')

    // AI가 또 고친다
    await write('a.txt', 'alpha AI-1\nbravo AI-2\ncharlie\n')

    const seen = await gitApi.seenFileDiff(repo, gitDir, 'a.txt')
    assert.match(seen, /^\+bravo AI-2$/m, '두 번째 수정은 보여야 한다')
    assert.doesNotMatch(seen, /^\+alpha AI-1$/m, '이미 확인한 수정은 빠져야 한다')

    // HEAD 대비는 둘 다 보인다 — 비교 대상이 다르면 결과도 달라야 한다
    const head = await gitApi.fileDiff(repo, 'a.txt', { context: 3 })
    assert.match(head, /^\+alpha AI-1$/m)
    assert.match(head, /^\+bravo AI-2$/m)
  })

  test('파일마다 시점이 따로다', async () => {
    // b.txt 는 아직 확인하지 않았다. a.txt 를 확인했다고 b.txt 의 기준이 생기면 안 된다.
    await write('b.txt', 'one\ntwo\nthree AI-1\n')
    assert.equal(await gitApi.seenFileDiff(repo, gitDir, 'b.txt'), null)

    await gitApi.markSeen(repo, gitDir, 'b.txt')
    assert.equal((await gitApi.seenFileDiff(repo, gitDir, 'b.txt')).trim(), '')

    // b.txt 를 확인했다고 a.txt 의 기준이 지금으로 밀려서는 안 된다
    const a = await gitApi.seenFileDiff(repo, gitDir, 'a.txt')
    assert.match(a, /^\+bravo AI-2$/m, 'a.txt 의 확인 시점은 그대로여야 한다')
  })

  test('여러 경로를 한 번에 기록한다 (전체 확인)', async () => {
    await write('a.txt', 'x\n')
    await write('b.txt', 'y\n')
    await gitApi.markSeen(repo, gitDir, ['a.txt', 'b.txt'])
    const paths = await gitApi.seenPaths(repo)
    assert.deepEqual([...paths].sort(), ['a.txt', 'b.txt'])
    assert.equal((await gitApi.seenFileDiff(repo, gitDir, 'a.txt')).trim(), '')
    assert.equal((await gitApi.seenFileDiff(repo, gitDir, 'b.txt')).trim(), '')
  })

  test('추적되지 않은 파일도 기록된다', async () => {
    // AI가 방금 만든 파일이 가장 자주 보는 것이다. 여기서 빠지면 쓸모가 없다.
    await write('new.txt', 'created by AI\n')
    await gitApi.markSeen(repo, gitDir, 'new.txt')
    assert.ok((await gitApi.seenPaths(repo)).has('new.txt'))

    await write('new.txt', 'created by AI\nand extended later\n')
    const diff = await gitApi.seenFileDiff(repo, gitDir, 'new.txt')
    assert.match(diff, /^\+and extended later$/m)
    assert.doesNotMatch(diff, /^\+created by AI$/m)
  })

  test('확인한 뒤 지워진 파일은 삭제로 나온다', async () => {
    await write('gone.txt', 'here\n')
    await gitApi.markSeen(repo, gitDir, 'gone.txt')
    await fs.rm(path.join(repo, 'gone.txt'))
    const diff = await gitApi.seenFileDiff(repo, gitDir, 'gone.txt')
    assert.match(diff, /^-here$/m)
  })

  test('지워진 파일을 다시 확인하면 스냅샷에서 빠진다', async () => {
    // `--add` 만 주면 없는 파일에서 실패해 트리가 갱신되지 않는다
    await gitApi.markSeen(repo, gitDir, 'gone.txt')
    assert.ok(!(await gitApi.seenPaths(repo)).has('gone.txt'))
  })

  test('기준점과 서로를 건드리지 않는다', async () => {
    // 둘은 index 파일을 나눠 쓴다. 같은 파일을 쓰면 stat 캐시가 서로 무너진다.
    await write('a.txt', 'baseline time\n')
    const base = await gitApi.setBaseline(repo, gitDir)
    const seenBefore = await gitApi.getSeen(repo)
    assert.ok(base)
    assert.notEqual(base, seenBefore, '기준점과 확인 시점은 다른 트리다')

    await write('a.txt', 'after baseline\n')
    await gitApi.markSeen(repo, gitDir, 'a.txt')

    // 기준점은 그대로여야 한다
    assert.equal(await gitApi.getBaseline(repo), base)
    const fromBaseline = await gitApi.baselineFileDiff(repo, gitDir, 'a.txt')
    assert.match(fromBaseline, /^\+after baseline$/m)
  })

  test('빈 경로 목록에는 아무 일도 하지 않는다', async () => {
    const before = await gitApi.getSeen(repo)
    assert.equal(await gitApi.markSeen(repo, gitDir, []), null)
    assert.equal(await gitApi.getSeen(repo), before)
  })

  test('해제하면 스냅샷이 사라진다', async () => {
    await gitApi.clearSeen(repo)
    assert.equal(await gitApi.getSeen(repo), null)
    assert.deepEqual([...(await gitApi.seenPaths(repo))], [])
    assert.equal(await gitApi.seenFileDiff(repo, gitDir, 'a.txt'), null)
  })
})

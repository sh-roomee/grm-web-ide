import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import * as gitApi from '../server/git.js'

/**
 * 원격 — fetch와 fast-forward pull.
 *
 * 진짜 네트워크 대신 로컬 bare 저장소를 origin으로 쓴다. 검증하고 싶은 것은
 * 전송이 아니라 이 도구의 약속이다: pull은 fast-forward만 하고, 갈라져 있으면
 * 히스토리를 건드리지 않고 실패한다.
 */

let base // origin을 만들 때 쓴 작업 저장소
let origin // bare origin
let clone // 테스트 대상 (grmide가 보는 저장소)
let tmp

const commitIn = (repo, message) =>
  gitApi.git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message])

const writeIn = (repo, rel, text) => fs.writeFile(path.join(repo, rel), text)

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grmide-remote-'))
  base = path.join(tmp, 'base')
  origin = path.join(tmp, 'origin.git')
  clone = path.join(tmp, 'clone')

  await fs.mkdir(base)
  await gitApi.git(base, ['init', '-q', '-b', 'main'])
  await writeIn(base, 'a.txt', 'one\n')
  await gitApi.git(base, ['add', '-A'])
  await commitIn(base, 'init')

  await gitApi.git(tmp, ['clone', '-q', '--bare', base, origin])
  await gitApi.git(tmp, ['clone', '-q', origin, clone])
})

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

/** origin에 커밋을 하나 밀어 넣는다 (base에서 만들어 push). */
async function advanceOrigin(rel, text, message) {
  await writeIn(base, rel, text)
  await gitApi.git(base, ['add', '-A'])
  await commitIn(base, message)
  await gitApi.git(base, ['push', '-q', origin, 'main'])
}

describe('원격 fetch / pull', () => {
  test('원격이 없으면 400으로 거절한다', async () => {
    await assert.rejects(() => gitApi.fetchRemote(base), (err) => err.status === 400)
    await assert.rejects(() => gitApi.pullFastForward(base), (err) => err.status === 400)
  })

  test('fetch는 원격의 새 커밋 수를 알려준다', async () => {
    await advanceOrigin('a.txt', 'one\ntwo\n', 'origin-1')
    const { counts } = await gitApi.fetchRemote(clone)
    assert.deepEqual(counts, { ahead: 0, behind: 1 })
  })

  test('pull은 fast-forward로 따라잡는다', async () => {
    const { counts } = await gitApi.pullFastForward(clone)
    assert.deepEqual(counts, { ahead: 0, behind: 0 })
    const content = await fs.readFile(path.join(clone, 'a.txt'), 'utf8')
    assert.equal(content, 'one\ntwo\n')
  })

  test('갈라져 있으면 pull이 실패하고 히스토리는 그대로다', async () => {
    // 로컬 커밋과 원격 커밋이 서로 모르는 상태를 만든다
    await writeIn(clone, 'b.txt', 'local\n')
    await gitApi.git(clone, ['add', '-A'])
    await commitIn(clone, 'local-1')
    await advanceOrigin('a.txt', 'one\ntwo\nthree\n', 'origin-2')

    const before = (await gitApi.git(clone, ['rev-parse', 'HEAD'])).trim()
    await assert.rejects(() => gitApi.pullFastForward(clone), /fast-forward|Not possible/i)
    const after = (await gitApi.git(clone, ['rev-parse', 'HEAD'])).trim()
    assert.equal(after, before) // 머지 커밋도, 리베이스도 만들지 않았다

    // 갈라진 상태의 개수도 사실대로 나온다
    const { counts } = await gitApi.fetchRemote(clone)
    assert.deepEqual(counts, { ahead: 1, behind: 1 })
  })
})

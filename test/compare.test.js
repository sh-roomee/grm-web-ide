import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import * as gitApi from '../server/git.js'

/**
 * 브랜치 비교 — merge-base 의미론이 핵심이다.
 *
 * 두 점(diff base HEAD)으로 만들면 base가 그동안 전진한 것까지 "이 브랜치의
 * 변경"처럼 나온다. 그 거짓은 화면만 봐서는 알 수 없어서(그럴듯한 diff가 뜬다)
 * 여기서 못 박는다: 기준이 전진해도 비교 결과는 브랜치가 실제로 만진 파일만이다.
 */

let repo

const commit = (message) =>
  gitApi.git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message])

const write = (rel, text) => fs.writeFile(path.join(repo, rel), text)

before(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'grmide-compare-'))
  await gitApi.git(repo, ['init', '-q', '-b', 'main'])
  await write('shared.txt', 'base\n')
  await gitApi.git(repo, ['add', '-A'])
  await commit('init')

  // 피처 브랜치: 커밋 두 개
  await gitApi.git(repo, ['checkout', '-q', '-b', 'feature'])
  await write('feature.txt', 'one\n')
  await gitApi.git(repo, ['add', '-A'])
  await commit('feature-1')
  await write('feature.txt', 'one\ntwo\n')
  await gitApi.git(repo, ['add', '-A'])
  await commit('feature-2')

  // 그 사이 main도 전진한다 — 이 변경이 비교에 섞이면 안 된다
  await gitApi.git(repo, ['checkout', '-q', 'main'])
  await write('main-only.txt', 'advanced\n')
  await gitApi.git(repo, ['add', '-A'])
  await commit('main-advance')
  await gitApi.git(repo, ['checkout', '-q', 'feature'])
})

after(async () => {
  if (repo) await fs.rm(repo, { recursive: true, force: true })
})

describe('브랜치 비교 (base...HEAD)', () => {
  test('기준이 전진해도 브랜치가 만진 파일만 나온다', async () => {
    const summary = await gitApi.compareSummary(repo, 'main')
    assert.deepEqual(
      summary.files.map((f) => f.path),
      ['feature.txt'], // main-only.txt가 섞이면 두 점 비교를 쓰고 있다는 뜻이다
    )
    assert.equal(summary.ahead, 2) // 이 브랜치의 커밋
    assert.equal(summary.behind, 1) // 기준이 앞서 있는 커밋 (참고용)
  })

  test('파일 diff는 merge-base → HEAD 다', async () => {
    const summary = await gitApi.compareSummary(repo, 'main')
    const raw = await gitApi.rangeFileDiff(repo, summary.mergeBase, 'HEAD', 'feature.txt')
    assert.match(raw, /\+one/)
    assert.match(raw, /\+two/) // 두 커밋의 누적이 한 diff로
    // 기준이 전진시킨 파일은 비어 있다
    const other = await gitApi.rangeFileDiff(repo, summary.mergeBase, 'HEAD', 'main-only.txt')
    assert.equal(other.trim(), '')
  })

  test('기본 기준은 원격 기본 브랜치가 없으면 main이다', async () => {
    assert.equal(await gitApi.defaultCompareBase(repo), 'main')
  })

  test('공통 조상이 없으면 400으로 거절한다', async () => {
    await gitApi.git(repo, ['checkout', '-q', '--orphan', 'island'])
    await gitApi.git(repo, ['rm', '-rq', '--cached', '.'], { allowFail: true })
    await write('island.txt', 'alone\n')
    await gitApi.git(repo, ['add', 'island.txt'])
    await commit('island-1')
    await assert.rejects(() => gitApi.compareSummary(repo, 'main'), (err) => err.status === 400)
    await gitApi.git(repo, ['checkout', '-qf', 'feature'])
  })
})

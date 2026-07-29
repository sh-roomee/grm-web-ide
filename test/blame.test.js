import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { parseBlamePorcelain } from '../server/blame.js'
import * as gitApi from '../server/git.js'

describe('blame porcelain 파서', () => {
  test('줄→sha와 커밋 상세를 가른다 (상세는 첫 등장에만 온다)', () => {
    const sha1 = 'a'.repeat(40)
    const sha2 = 'b'.repeat(40)
    const raw = [
      `${sha1} 1 1 2`,
      'author 강성훈',
      'author-mail <a@b.c>',
      'author-time 1700000000',
      'summary 첫 커밋',
      'filename f.txt',
      '\tline one',
      `${sha1} 2 2`,
      '\tline two',
      `${sha2} 1 3 1`,
      'author garam',
      'author-mail <g@b.c>',
      'author-time 1710000000',
      'summary 두 번째',
      'filename f.txt',
      '\tline three',
      '',
    ].join('\n')

    const { lines, commits } = parseBlamePorcelain(raw)
    assert.deepEqual(lines, { 1: sha1, 2: sha1, 3: sha2 })
    assert.equal(commits[sha1].author, '강성훈')
    assert.equal(commits[sha1].mail, 'a@b.c')
    assert.equal(commits[sha1].time, 1700000000)
    assert.equal(commits[sha2].summary, '두 번째')
  })
})

describe('blameFile 통합', () => {
  let repo
  const commit = (m, env) =>
    gitApi.git(repo, ['-c', `user.email=${env}@t`, '-c', `user.name=${env}`, 'commit', '-q', '-m', m])

  before(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'grmide-blame-'))
    await gitApi.git(repo, ['init', '-q', '-b', 'main'])
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n')
    await gitApi.git(repo, ['add', '-A'])
    await commit('first', 'alice')
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n')
    await gitApi.git(repo, ['add', '-A'])
    await commit('second', 'bob')
    // 커밋 안 된 줄도 하나
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  })

  after(async () => {
    if (repo) await fs.rm(repo, { recursive: true, force: true })
  })

  test('줄마다 작성자가 갈리고, 커밋 안 된 줄은 sha가 0이다', async () => {
    const { lines, commits } = await gitApi.blameFile(repo, 'a.txt')
    assert.equal(commits[lines[1]].author, 'alice')
    assert.equal(commits[lines[3]].author, 'bob')
    assert.equal(lines[4], '0'.repeat(40))
  })
})

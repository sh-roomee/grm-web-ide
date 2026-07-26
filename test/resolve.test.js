import assert from 'node:assert/strict'
import { test } from 'node:test'

import { commentStatus, attachStatus } from '../server/resolve.js'

const comment = (over = {}) => ({
  id: 'c1',
  path: 'src/app.js',
  line: 3,
  side: 'right',
  code: '  const ctx = new AudioContext()',
  text: '해제 경로가 없다',
  sha: null,
  ...over,
})

const file = (text) => ({ text, mtime: 1_700_000_000_000 })

test('코드가 그대로 있으면 아직 안 고친 것이다', () => {
  const now = file('function a() {\n  const ctx = new AudioContext()\n}\n')
  assert.equal(commentStatus(comment(), now).state, 'open')
})

test('코드가 사라졌으면 반영된 것으로 본다', () => {
  const now = file('function a() {\n  const ctx = pool.acquire()\n}\n')
  const status = commentStatus(comment(), now)
  assert.equal(status.state, 'applied')
  assert.equal(status.reason, 'changed')
})

test('줄 번호가 밀려도 따라간다', () => {
  // 위에 20줄이 추가돼 원래 줄 번호(3)에는 다른 코드가 있다
  const now = file('x\n'.repeat(20) + '  const ctx = new AudioContext()\n')
  assert.equal(commentStatus(comment(), now).state, 'open', '줄 번호로 보면 오판한다')
})

test('줄 끝 공백과 개행 방식 차이로 오판하지 않는다', () => {
  const now = file('function a() {\r\n  const ctx = new AudioContext()   \r\n}\r\n')
  assert.equal(commentStatus(comment(), now).state, 'open')
})

test('삭제된 쪽 코멘트는 방향이 뒤집힌다', () => {
  const removed = comment({ side: 'left', code: '  reportError(err)' })
  // 아직 지워진 채로 있다 = 아직
  assert.equal(commentStatus(removed, file('function a() {}\n')).state, 'open')
  // 되살아났다 = 반영
  const restored = commentStatus(removed, file('function a() {\n  reportError(err)\n}\n'))
  assert.equal(restored.state, 'applied')
  assert.equal(restored.reason, 'restored')
})

test('파일이 사라졌으면 오른쪽 코멘트는 반영, 왼쪽은 아직', () => {
  assert.equal(commentStatus(comment(), file(null)).state, 'applied')
  assert.equal(commentStatus(comment({ side: 'left' }), file(null)).state, 'open')
})

test('커밋에 단 코멘트는 판정하지 않는다', () => {
  const onCommit = comment({ sha: '58f27b2' })
  const status = commentStatus(onCommit, file('아무 내용'))
  assert.equal(status.state, 'frozen', '커밋 내용은 바뀌지 않으므로 판정이 의미 없다')
})

test('코드 조각이 없으면 판정하지 않는다', () => {
  assert.equal(commentStatus(comment({ code: '' }), file('x')).state, 'unknown')
  assert.equal(commentStatus(comment({ code: '   \n  ' }), file('x')).state, 'unknown')
})

test('attachStatus는 파일을 경로별로 나눠 본다', () => {
  const comments = [
    comment({ id: 'a', path: 'src/a.js', code: 'keep()' }),
    comment({ id: 'b', path: 'src/b.js', code: 'gone()' }),
  ]
  const files = new Map([
    ['src/a.js', file('keep()\n')],
    ['src/b.js', file('other()\n')],
  ])
  const out = attachStatus(comments, files)
  assert.equal(out[0].status.state, 'open')
  assert.equal(out[1].status.state, 'applied')
  assert.equal(out[0].status.fileMtime, 1_700_000_000_000)
  // 원본 필드는 그대로 남아야 한다
  assert.equal(out[0].text, '해제 경로가 없다')
})

test('읽지 못한 파일은 없는 것으로 다룬다', () => {
  const out = attachStatus([comment({ path: 'gone.js' })], new Map())
  assert.equal(out[0].status.state, 'applied')
  assert.equal(out[0].status.fileMtime, null)
})

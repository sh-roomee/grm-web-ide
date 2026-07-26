import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildCycleSummary, elapsedLabel } from '../server/cycle.js'

const NOW = Date.parse('2026-07-26T02:00:00.000Z')
const file = (over = {}) => ({
  path: 'src/a.js',
  status: 'modified',
  staged: false,
  additions: 3,
  deletions: 1,
  reviewed: false,
  ...over,
})

test('경과 시간은 분·시간으로 읽는다', () => {
  assert.equal(elapsedLabel('2026-07-26T01:38:00.000Z', NOW), '22분')
  assert.equal(elapsedLabel('2026-07-26T01:59:50.000Z', NOW), '방금')
  assert.equal(elapsedLabel('2026-07-26T00:00:00.000Z', NOW), '2시간')
  assert.equal(elapsedLabel('2026-07-25T23:30:00.000Z', NOW), '2시간 30분')
  assert.equal(elapsedLabel(null, NOW), '')
  assert.equal(elapsedLabel('말도 안 되는 값', NOW), '')
})

test('기준점이 있으면 그 이후로 말한다', () => {
  const out = buildCycleSummary({
    files: [file()],
    baselineAt: '2026-07-26T01:38:00.000Z',
    now: NOW,
  })
  assert.match(out, /## 기준점 이후 \(22분\)/)
})

test('기준점이 없으면 워킹트리로 말한다', () => {
  const out = buildCycleSummary({ files: [file()], now: NOW })
  assert.match(out, /## 지금 워킹트리/)
  assert.ok(!out.includes('기준점'))
})

test('규모와 확인 진행률을 센다', () => {
  const out = buildCycleSummary({
    files: [file(), file({ path: 'b.js', additions: 10, deletions: 4, reviewed: true })],
    now: NOW,
  })
  assert.match(out, /파일 2개 · \+13 −5 · 확인 1\/2/)
})

test('확인 안 한 것과 확인한 것을 나눈다', () => {
  const out = buildCycleSummary({
    files: [file({ path: 'pending.js' }), file({ path: 'done.js', reviewed: true })],
    now: NOW,
  })
  const pendingAt = out.indexOf('아직 확인 안 한 파일')
  const checkedAt = out.indexOf('확인한 파일')
  assert.ok(pendingAt > -1 && checkedAt > pendingAt, '남은 것이 먼저 와야 한다')
  assert.ok(out.indexOf('pending.js') < checkedAt)
  assert.ok(out.indexOf('done.js') > checkedAt)
})

test('위험 신호는 그 파일 줄에 붙는다', () => {
  const out = buildCycleSummary({
    files: [file({ path: 'src/api.js' })],
    risks: { 'src/api.js': [{ label: '사라진 에러 처리', count: 3 }] },
    now: NOW,
  })
  assert.match(out, /src\/api\.js.*⚠ 사라진 에러 처리 3/)
})

test('아직 반영 안 된 코멘트만 담는다', () => {
  const out = buildCycleSummary({
    files: [file()],
    comments: [
      { path: 'a.js', line: 3, text: '이거 왜?', status: { state: 'open' } },
      { path: 'b.js', line: 9, text: '이미 고쳐짐', status: { state: 'applied' } },
    ],
    now: NOW,
  })
  assert.match(out, /아직 반영 안 된 코멘트 1/)
  assert.match(out, /- a\.js:3 {2}이거 왜\?/)
  assert.ok(!out.includes('이미 고쳐짐'))
})

test('여러 줄 코멘트는 한 줄로 편다', () => {
  const out = buildCycleSummary({
    files: [file()],
    comments: [
      { path: 'a.js', line: 3, endLine: 6, text: '첫 줄\n둘째 줄', status: { state: 'open' } },
    ],
    now: NOW,
  })
  assert.match(out, /- a\.js:3-6 {2}첫 줄 둘째 줄/, '목록이 깨지지 않아야 한다')
})

test('바이너리 파일은 줄 수 대신 bin', () => {
  const out = buildCycleSummary({
    files: [file({ path: 'logo.png', additions: null, deletions: null })],
    now: NOW,
  })
  assert.match(out, /logo\.png {2}bin/)
})

test('바뀐 것이 없으면 그렇게 말한다', () => {
  const out = buildCycleSummary({ files: [], now: NOW })
  assert.match(out, /바뀐 파일이 없다/)
})

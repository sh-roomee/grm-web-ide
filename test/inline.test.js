import assert from 'node:assert/strict'
import { test } from 'node:test'

import { flattenInline } from '../web/src/inline.js'

/** DiffViewer가 만드는 `items` 항목 모양을 최소한으로 흉내 낸다. */
const cell = (num, text) => ({ num, text, words: null })
const row = (type, left, right, blockIndex = null, key = 'r1') => ({
  kind: 'row',
  row: { type, left, right },
  left: left ? { spans: [{ text: left.text }], first: null } : null,
  right: right ? { spans: [{ text: right.text }], first: null } : null,
  blockIndex,
  key,
})

test('문맥 행은 오른쪽 셀 한 줄이 된다', () => {
  const out = flattenInline([row('context', cell(3, 'a'), cell(4, 'a'))])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'line')
  assert.equal(out[0].type, 'context')
  assert.equal(out[0].sign, '')
  assert.equal(out[0].side, 'right')
  assert.equal(out[0].cell.num, 4)
  // 왼쪽 번호도 들고 있어야 한다 — 삭제된 쪽에 달린 코멘트를 찾는 데 쓴다
  assert.equal(out[0].oldNum, 3)
  assert.equal(out[0].newNum, 4)
})

test('변경 행은 삭제 줄 다음에 추가 줄로 펼쳐진다', () => {
  const out = flattenInline([row('mod', cell(10, 'old'), cell(10, 'new'), 0)])
  assert.deepEqual(
    out.map((line) => [line.type, line.sign, line.side, line.cell.num]),
    [
      ['del', '−', 'left', 10],
      ['add', '+', 'right', 10],
    ],
  )
})

test('블록 번호는 펼친 첫 줄에만 붙는다', () => {
  const out = flattenInline([row('mod', cell(1, 'a'), cell(1, 'b'), 7)])
  assert.equal(out[0].blockIndex, 7)
  assert.equal(out[1].blockIndex, null, '두 줄에 붙으면 변경 이동이 같은 자리를 두 번 센다')
})

test('추가만 있는 행과 삭제만 있는 행', () => {
  const added = flattenInline([row('add', null, cell(5, '+'), 1)])
  assert.equal(added.length, 1)
  assert.equal(added[0].type, 'add')
  assert.equal(added[0].blockIndex, 1)

  const removed = flattenInline([row('del', cell(9, '-'), null, 2)])
  assert.equal(removed.length, 1)
  assert.equal(removed[0].type, 'del')
  assert.equal(removed[0].blockIndex, 2)
})

test('행이 아닌 항목(훅 헤더)은 그대로 통과한다', () => {
  const hunk = { kind: 'hunk', hunk: { oldStart: 1 }, key: 'h1' }
  const out = flattenInline([hunk, row('context', cell(1, 'a'), cell(1, 'a'))])
  assert.equal(out[0], hunk)
  assert.equal(out[1].kind, 'line')
})

test('키는 줄마다 달라야 한다', () => {
  const out = flattenInline([
    row('mod', cell(1, 'a'), cell(1, 'b'), 0, 'r5'),
    row('context', cell(2, 'c'), cell(2, 'c'), null, 'r6'),
  ])
  const keys = out.map((line) => line.key)
  assert.equal(new Set(keys).size, keys.length, `키가 겹치면 Vue가 줄을 잘못 다시 쓴다: ${keys}`)
})

test('찾기 번호는 그 셀의 것을 물려받는다', () => {
  const item = row('mod', cell(1, 'a'), cell(1, 'b'), 0)
  item.left.first = 3
  item.right.first = 4
  const out = flattenInline([item])
  assert.equal(out[0].hit, 3)
  assert.equal(out[1].hit, 4)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizeItem,
  itemKey,
  itemLabel,
  buildContextPrompt,
  MAX_FILE_LINES,
} from '../server/context.js'

test('파일 / 구간 / 검색을 정규화한다', () => {
  assert.deepEqual(normalizeItem({ kind: 'file', path: 'src/a.js' }), {
    kind: 'file',
    path: 'src/a.js',
  })
  assert.deepEqual(normalizeItem({ kind: 'range', path: 'src/a.js', line: 3, endLine: 9 }), {
    kind: 'range',
    path: 'src/a.js',
    line: 3,
    endLine: 9,
  })
  assert.deepEqual(normalizeItem({ kind: 'grep', query: '  selectedLocked  ' }), {
    kind: 'grep',
    query: 'selectedLocked',
  })
})

test('kind가 없으면 파일로 본다', () => {
  assert.deepEqual(normalizeItem({ path: 'a.js' }), { kind: 'file', path: 'a.js' })
})

test('한 줄짜리 구간은 endLine이 line과 같다', () => {
  assert.equal(normalizeItem({ kind: 'range', path: 'a.js', line: 5 }).endLine, 5)
  // 거꾸로 온 범위도 한 줄로 다룬다 (끌다가 위로 올라간 경우)
  assert.equal(normalizeItem({ kind: 'range', path: 'a.js', line: 5, endLine: 2 }).endLine, 5)
})

test('모양이 어긋난 것은 담지 않는다', () => {
  assert.equal(normalizeItem(null), null)
  assert.equal(normalizeItem({ kind: 'file', path: '' }), null)
  assert.equal(normalizeItem({ kind: 'grep', query: '   ' }), null)
  assert.equal(normalizeItem({ kind: 'range', path: 'a.js', line: 0 }), null)
  assert.equal(normalizeItem({ kind: 'range', path: 'a.js' }), null)
})

test('같은 것을 두 번 담지 않게 열쇠가 같다', () => {
  const a = normalizeItem({ kind: 'file', path: 'src/a.js' })
  const b = normalizeItem({ path: 'src/a.js' })
  assert.equal(itemKey(a), itemKey(b))
  // 구간이 다르면 다른 항목이다
  assert.notEqual(
    itemKey(normalizeItem({ kind: 'range', path: 'a.js', line: 1, endLine: 4 })),
    itemKey(normalizeItem({ kind: 'range', path: 'a.js', line: 2, endLine: 4 })),
  )
})

test('이름은 화면과 프롬프트가 같다', () => {
  assert.equal(itemLabel({ kind: 'file', path: 'src/a.js' }), 'src/a.js')
  assert.equal(itemLabel({ kind: 'range', path: 'a.js', line: 3, endLine: 9 }), 'a.js:3-9')
  assert.equal(itemLabel({ kind: 'range', path: 'a.js', line: 3, endLine: 3 }), 'a.js:3')
  assert.equal(itemLabel({ kind: 'grep', query: 'foo' }), '검색: "foo"')
})

test('파일은 코드 펜스와 함께 담긴다', () => {
  const item = { kind: 'file', path: 'src/a.vue' }
  const sources = new Map([[itemKey(item), { lines: ['<template>', '</template>'] }]])
  const prompt = buildContextPrompt([item], sources)
  assert.match(prompt, /## src\/a\.vue/)
  assert.match(prompt, /```vue\n<template>\n<\/template>\n```/)
})

test('긴 파일은 자르고, 잘랐다고 말한다', () => {
  const item = { kind: 'file', path: 'big.js' }
  const lines = Array.from({ length: MAX_FILE_LINES + 50 }, (_, i) => `line ${i + 1}`)
  const prompt = buildContextPrompt([item], new Map([[itemKey(item), { lines }]]))
  assert.ok(prompt.includes(`line ${MAX_FILE_LINES}`))
  assert.ok(!prompt.includes(`line ${MAX_FILE_LINES + 1}`))
  // 잘린 것을 감추면 AI가 "여기 없다"를 근거로 잘못 판단한다
  assert.match(prompt, new RegExp(`앞 ${MAX_FILE_LINES}줄만`))
})

test('읽지 못한 파일은 그렇게 적는다', () => {
  const item = { kind: 'file', path: 'gone.js' }
  const prompt = buildContextPrompt([item], new Map([[itemKey(item), { missing: true }]]))
  assert.match(prompt, /읽을 수 없다/)
})

test('검색 결과는 경로:줄 형태로 담긴다', () => {
  const item = { kind: 'grep', query: 'foo' }
  const sources = new Map([
    [itemKey(item), { hits: [{ path: 'a.js', line: 3, text: 'foo()' }], total: 1 }],
  ])
  const prompt = buildContextPrompt([item], sources)
  assert.match(prompt, /## 검색: "foo"/)
  assert.match(prompt, /a\.js:3: foo\(\)/)
})

test('결과가 없는 검색도 그렇게 적는다', () => {
  const item = { kind: 'grep', query: 'nope' }
  const prompt = buildContextPrompt([item], new Map([[itemKey(item), { hits: [], total: 0 }]]))
  assert.match(prompt, /결과 없음/)
})

test('빈 바구니는 빈 문자열', () => {
  assert.equal(buildContextPrompt([], new Map()), '')
})

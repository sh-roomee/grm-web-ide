import assert from 'node:assert/strict'
import { test } from 'node:test'

import { useTabs, tabId } from '../web/src/composables/useTabs.js'

/**
 * 탭 규칙: 한 번 누르면 자리를 대신하고(미리 보기), 두 번 누르면 붙잡는다.
 *
 * 이 로직은 화면 없이 돌아가는 순수 상태 기계라 여기서 검증한다. "훑어봐도 쌓이지
 * 않는다"와 "붙잡은 것은 밀려나지 않는다"가 어긋나면 도구를 쓸 수 없게 된다.
 */

const work = (path, staged = false) => ({ kind: 'worktree', path, staged, sub: 'working tree' })
const file = (path) => ({ kind: 'file', path, sub: '읽기 전용' })

const paths = (t) => t.tabs.value.map((x) => x.path)
const previews = (t) => t.tabs.value.filter((x) => x.preview).map((x) => x.path)

// --- 미리 보기

test('훑어봐도 탭이 쌓이지 않는다', () => {
  const t = useTabs()
  t.open(work('a.js'))
  t.open(work('b.js'))
  t.open(work('c.js'))
  assert.deepEqual(paths(t), ['c.js'])
  assert.equal(t.active.value.path, 'c.js')
})

test('미리 보기 탭은 하나뿐이다', () => {
  const t = useTabs()
  t.open(work('a.js'))
  t.open(work('b.js'), { pin: true })
  t.open(work('c.js'))
  assert.deepEqual(previews(t), ['c.js'])
})

test('미리 보기는 있던 자리를 물려받는다', () => {
  const t = useTabs()
  t.open(work('keep1.js'), { pin: true })
  t.open(work('preview.js'))
  t.open(work('keep2.js'), { pin: true })
  // 미리 보기가 가운데 있다. 다음 미리 보기도 가운데여야 한다 — 탭이 튀어 다니면
  // 방금 누른 것을 눈으로 다시 찾아야 한다.
  assert.deepEqual(paths(t), ['keep1.js', 'preview.js', 'keep2.js'])
  t.open(work('next.js'))
  assert.deepEqual(paths(t), ['keep1.js', 'next.js', 'keep2.js'])
})

// --- 붙잡기

test('두 번 누르면 붙잡히고 다음 것이 그 자리를 밀어내지 않는다', () => {
  const t = useTabs()
  t.open(work('a.js'))
  t.open(work('a.js'), { pin: true }) // 두 번 누름 = click + dblclick
  t.open(work('b.js'))
  assert.deepEqual(paths(t), ['a.js', 'b.js'])
  assert.deepEqual(previews(t), ['b.js'])
})

test('pin()으로 지금 미리 보기를 붙잡는다 (탭 두 번 누르기)', () => {
  const t = useTabs()
  const tab = t.open(work('a.js'))
  assert.equal(tab.preview, true)
  t.pin(tab.id)
  assert.equal(tab.preview, false)
  t.open(work('b.js'))
  assert.deepEqual(paths(t), ['a.js', 'b.js'])
})

test('붙잡아 열면 미리 보기 탭을 밀어내지 않는다', () => {
  const t = useTabs()
  t.open(work('preview.js'))
  t.open(work('pinned.js'), { pin: true })
  assert.deepEqual(paths(t), ['preview.js', 'pinned.js'])
})

test('이미 열린 탭을 다시 열면 옮겨가기만 한다', () => {
  const t = useTabs()
  t.open(work('a.js'), { pin: true })
  t.open(work('b.js'), { pin: true })
  t.open(work('a.js'))
  assert.deepEqual(paths(t), ['a.js', 'b.js'])
  assert.equal(t.activeId.value, tabId(work('a.js')))
  // 붙잡은 것을 한 번 눌렀다고 미리 보기로 되돌리지 않는다
  assert.deepEqual(previews(t), [])
})

test('이미 열어 둔 문서의 다른 절을 가리키는 링크는 앵커만 갱신한다', () => {
  const t = useTabs()
  t.open({ ...file('a.md'), hash: '첫-절' }, { pin: true })
  t.open({ ...file('a.md'), hash: '둘째-절' })
  assert.equal(t.tabs.value.length, 1, '같은 문서라 탭이 늘지 않는다')
  assert.equal(t.tabs.value[0].hash, '둘째-절')
})

// --- 되살리기 (⌥⇧T)

test('붙잡은 탭을 닫으면 되살릴 수 있다', () => {
  const t = useTabs()
  t.open(file('a.md'), { pin: true })
  t.open(file('b.md'), { pin: true })
  assert.equal(t.canReopen.value, false)

  t.close(tabId(file('a.md')))
  assert.deepEqual(paths(t), ['b.md'])
  assert.equal(t.canReopen.value, true)

  const back = t.reopen()
  assert.equal(back.path, 'a.md')
  // 있던 자리로 돌아온다
  assert.deepEqual(paths(t), ['a.md', 'b.md'])
  assert.equal(t.canReopen.value, false)
})

test('되살린 탭은 붙잡힌 상태다', () => {
  const t = useTabs()
  t.open(file('a.md'), { pin: true })
  t.close(tabId(file('a.md')))
  const back = t.reopen()
  assert.equal(back.preview, false)
  // 일부러 되살렸는데 다음 미리 보기에 밀려나면 안 된다
  t.open(file('b.md'))
  assert.deepEqual(paths(t), ['a.md', 'b.md'])
})

test('닫은 순서의 역순으로 되살아난다', () => {
  const t = useTabs()
  t.open(file('a.md'), { pin: true })
  t.open(file('b.md'), { pin: true })
  t.close(tabId(file('a.md')))
  t.close(tabId(file('b.md')))
  assert.equal(t.reopen().path, 'b.md')
  assert.equal(t.reopen().path, 'a.md')
  assert.equal(t.reopen(), null)
})

test('미리 보기를 닫은 것은 되살림 목록에 넣지 않는다', () => {
  const t = useTabs()
  const tab = t.open(work('a.js'))
  t.close(tab.id)
  assert.equal(t.canReopen.value, false)
})

test('모두 닫아도 하나씩 되살릴 수 있다', () => {
  const t = useTabs()
  t.open(file('a.md'), { pin: true })
  t.open(file('b.md'), { pin: true })
  t.open(file('c.md')) // 미리 보기는 남지 않는다
  t.closeAll()
  assert.deepEqual(paths(t), [])
  assert.equal(t.reopen().path, 'b.md')
  assert.equal(t.reopen().path, 'a.md')
  assert.equal(t.reopen(), null)
})

test('되살릴 것이 이미 열려 있으면 그 탭으로 간다', () => {
  const t = useTabs()
  t.open(file('a.md'), { pin: true })
  t.close(tabId(file('a.md')))
  t.open(file('a.md')) // 되살리기 전에 다시 열었다
  const back = t.reopen()
  assert.equal(back.path, 'a.md')
  assert.equal(paths(t).length, 1, '두 개가 되면 안 된다')
  assert.equal(back.preview, false, '되살렸으니 붙잡힌다')
})

test('데이터는 되살리지 않는다', () => {
  // 닫은 뒤 워킹트리가 바뀌었을 수 있다. 다시 받는 편이 맞다.
  const t = useTabs()
  const tab = t.open(work('a.js'), { pin: true })
  tab.data = { hunks: ['오래된 것'] }
  t.close(tab.id)
  assert.equal(t.reopen().data, null)
})

// --- 넘칠 때

test('12개가 넘으면 가장 오래 안 본 것을 버린다', () => {
  const t = useTabs()
  for (let i = 0; i < 14; i++) t.open(file(`f${i}.md`), { pin: true })
  assert.equal(t.tabs.value.length, 12)
  assert.equal(paths(t).includes('f0.md'), false)
  assert.equal(paths(t).includes('f13.md'), true)
})

test('자동으로 밀려난 것은 되살림 목록에 넣지 않는다', () => {
  // 사람이 닫은 것이 아니다. ⌥⇧T가 엉뚱한 것을 되살리면 안 된다.
  const t = useTabs()
  for (let i = 0; i < 14; i++) t.open(file(`f${i}.md`), { pin: true })
  assert.equal(t.canReopen.value, false)
})

test('미리 보기만 쓰면 탭이 넘치지 않는다', () => {
  const t = useTabs()
  for (let i = 0; i < 40; i++) t.open(work(`f${i}.js`))
  assert.equal(t.tabs.value.length, 1)
})

// --- 목록에서 사라진 것

test('커밋해서 사라진 워킹트리 탭은 되살리지 않는다', () => {
  const t = useTabs()
  t.open(work('a.js'), { pin: true })
  t.open(work('b.js'), { pin: true })
  t.pruneWorktree(new Set(['unstaged:b.js']))
  assert.deepEqual(paths(t), ['b.js'])
  // 그 변경은 이제 없다. 되살릴 대상이 아니다.
  assert.equal(t.canReopen.value, false)
})

test('staged/unstaged 는 다른 탭이다', () => {
  const t = useTabs()
  t.open(work('a.js', false), { pin: true })
  t.open(work('a.js', true), { pin: true })
  assert.equal(t.tabs.value.length, 2)
})

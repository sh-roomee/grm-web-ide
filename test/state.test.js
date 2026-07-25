import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildPrompt } from '../server/state.js'

const comment = (over = {}) => ({
  id: 'c1',
  path: 'web/src/App.vue',
  line: 214,
  side: 'right',
  code: '    if (line) await nextTick(() => scrollToLine(line))',
  text: '이 nextTick 왜 필요해?',
  sha: null,
  createdAt: '2026-07-25T20:00:00+09:00',
  ...over,
})

test('코멘트가 없으면 빈 문자열', () => {
  assert.equal(buildPrompt([]), '')
})

test('경로 · 줄 번호 · 그때 본 코드 · 코멘트가 모두 들어간다', () => {
  const out = buildPrompt([comment()])
  assert.match(out, /아래 리뷰 코멘트를 반영해줘/)
  assert.ok(out.includes('web/src/App.vue:214'), '경로와 줄 번호')
  assert.ok(out.includes('if (line) await nextTick'), '그때 본 코드')
  assert.ok(out.includes('이 nextTick 왜 필요해?'), '코멘트 내용')
})

test('확장자에 맞는 코드 펜스를 붙인다', () => {
  assert.ok(buildPrompt([comment()]).includes('```vue'))
  assert.ok(buildPrompt([comment({ path: 'server/git.js' })]).includes('```js'))
  assert.ok(buildPrompt([comment({ path: 'docs/API.md' })]).includes('```md'))
  // 모르는 확장자는 기본값
  assert.ok(buildPrompt([comment({ path: 'Makefile' })]).includes('```text'))
})

test('같은 파일의 코멘트는 한 절로 묶고 줄 번호 순으로 정렬한다', () => {
  const out = buildPrompt([
    comment({ id: 'a', line: 300, text: '나중 줄' }),
    comment({ id: 'b', line: 100, text: '앞 줄' }),
  ])
  // 파일 제목은 한 번만
  assert.equal(out.match(/^## web\/src\/App\.vue$/gm).length, 1)
  assert.ok(out.indexOf('앞 줄') < out.indexOf('나중 줄'), '줄 번호 순')
})

test('파일이 여러 개면 파일별로 절을 만든다', () => {
  const out = buildPrompt([comment(), comment({ id: 'x', path: 'server/git.js', line: 88 })])
  assert.ok(out.includes('## web/src/App.vue'))
  assert.ok(out.includes('## server/git.js'))
})

test('코드가 비어 있으면 펜스를 넣지 않는다', () => {
  const out = buildPrompt([comment({ code: '   ' })])
  assert.ok(!out.includes('```'), '빈 코드 블록이 생기면 안 된다')
  assert.ok(out.includes('이 nextTick 왜 필요해?'))
})

test('줄 번호가 없으면 경로만 쓴다', () => {
  const out = buildPrompt([comment({ line: null })])
  assert.ok(out.includes('### web/src/App.vue'))
  assert.ok(!out.includes('App.vue:null'))
})

test('여러 줄 범위는 path:from-to 로 표기한다', () => {
  const out = buildPrompt([
    comment({
      line: 240,
      endLine: 244,
      code: '    if(this.isTeacherMode){\n      this.toggleTeacherMode({\n      });',
      text: '이 블록 전체를 왜 이렇게 바꿨어?',
    }),
  ])
  assert.ok(out.includes('web/src/App.vue:240-244'), '범위 표기')
  assert.ok(out.includes('toggleTeacherMode'), '고른 줄들이 모두 들어간다')
})

test('endLine이 line과 같거나 없으면 한 줄로 표기한다', () => {
  assert.ok(buildPrompt([comment({ line: 10, endLine: null })]).includes('App.vue:10'))
  assert.ok(!buildPrompt([comment({ line: 10, endLine: 10 })]).includes('10-10'))
})

test('마지막에 개행 하나로 끝난다 (붙여넣기 대비)', () => {
  const out = buildPrompt([comment()])
  assert.ok(out.endsWith('\n'))
  assert.ok(!out.endsWith('\n\n'))
})

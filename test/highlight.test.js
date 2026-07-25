import assert from 'node:assert/strict'
import { test } from 'node:test'

import { highlightLine, buildSpans, resolvePlugin } from '../web/src/highlight/index.js'
import { sfcSections, detectLanguage } from '../server/language.js'

/** 특정 문자열 조각이 어떤 클래스로 칠해졌는지 */
function classOf(spans, needle) {
  return spans.find((s) => s.text === needle)?.cls
}

function rendered(spans) {
  return spans.map((s) => s.text).join('')
}

test('span을 이어붙이면 원본 줄이 그대로 복원된다', () => {
  const lines = [
    '  <div v-else class="room-setting-display-wrapper">',
    "    const x = foo(1, 'two') // 주석",
    '  .selected { color: #fff; }',
    '',
    '   ',
  ]
  for (const language of ['markup', 'javascript', 'css', 'vue', 'plain']) {
    for (const line of lines) {
      assert.equal(rendered(highlightLine(language, line, null, {})), line, `${language}: ${line}`)
    }
  }
})

test('javascript: 키워드/문자열/주석/함수를 구분한다', () => {
  const spans = highlightLine('javascript', "const name = getNoiseCancel('a') // 끝", null, {})
  assert.equal(classOf(spans, 'const'), 'keyword')
  assert.equal(classOf(spans, "'a'"), 'string')
  assert.equal(classOf(spans, 'getNoiseCancel'), 'function')
  assert.equal(classOf(spans, '// 끝'), 'comment')
})

test('markup: 태그/디렉티브/속성/문자열을 구분한다', () => {
  const line = '<div v-else-if="isTeacherMode" class="room-setting-display-wrapper">'
  const spans = highlightLine('markup', line, null, {})
  assert.equal(classOf(spans, '<div'), 'tag')
  assert.equal(classOf(spans, 'v-else-if'), 'directive')
  assert.equal(classOf(spans, 'class'), 'attr')
  // 디렉티브가 아닌 속성 값은 따옴표까지 통째로 문자열이다
  assert.equal(classOf(spans, '"room-setting-display-wrapper"'), 'string')
  assert.equal(classOf(spans, '>'), 'tag')
})

test('markup: 디렉티브 값은 JS 식으로 칠한다', () => {
  const spans = highlightLine('markup', '<li :class="[{ selected : a === b }]">', null, {})
  // 값 안쪽이 통째로 문자열이 되면 안 된다
  assert.equal(classOf(spans, 'selected'), 'property')
  assert.equal(classOf(spans, '==='), 'operator')
})

test('markup: {{ }} 안쪽도 JS로 칠한다', () => {
  const spans = highlightLine('markup', '<p>{{ setDisableText() }}</p>', null, {})
  assert.equal(classOf(spans, '{{'), 'interp')
  assert.equal(classOf(spans, 'setDisableText'), 'function')
  assert.equal(classOf(spans, '}}'), 'interp')
})

test('markup: 여러 줄에 걸친 태그의 이어지는 줄도 속성으로 인식한다', () => {
  // `<li v-for="..."` 다음 줄. 태그 시작이 이 줄에 없다.
  const spans = highlightLine('markup', '    :key="displayMode.type"', null, {})
  assert.equal(classOf(spans, ':key'), 'directive')
})

test('vue: 줄 번호와 구획으로 언어를 고른다', () => {
  const sections = [
    { start: 1, end: 20, lang: 'markup' },
    { start: 22, end: 300, lang: 'javascript' },
    { start: 302, end: 400, lang: 'css' },
  ]
  const asMarkup = highlightLine('vue', '<div class="a">', null, { lineNo: 5, sections })
  assert.equal(classOf(asMarkup, '<div'), 'tag')

  // script 구획 안에서는 같은 줄이 JS로 해석된다
  const asJs = highlightLine('vue', "  const x = 'a'", null, { lineNo: 249, sections })
  assert.equal(classOf(asJs, 'const'), 'keyword')

  const asCss = highlightLine('vue', '  .selected { color: red; }', null, { lineNo: 310, sections })
  assert.equal(classOf(asCss, '.selected'), 'selector')
  assert.equal(classOf(asCss, 'color'), 'attr')
})

test('vue: 구획 정보가 없으면 템플릿으로 취급한다', () => {
  const spans = highlightLine('vue', '<div class="a">', null, {})
  assert.equal(classOf(spans, '<div'), 'tag')
})

test('sfcSections: 최상위 블록만 잡는다', () => {
  const content = [
    '<template>', // 1
    '  <div>', // 2
    '    <style>이건 텍스트</style>', // 3  (1열이 아니므로 블록이 아니다)
    '  </div>', // 4
    '</template>', // 5
    '', // 6
    '<script>', // 7
    'export default {}', // 8
    '</script>', // 9
    '', // 10
    '<style lang="scss" scoped>', // 11
    '.a { color: red; }', // 12
    '</style>', // 13
  ].join('\n')

  assert.deepEqual(sfcSections(content), [
    { start: 1, end: 5, lang: 'markup' },
    { start: 7, end: 9, lang: 'javascript' },
    { start: 11, end: 13, lang: 'css' },
  ])
})

test('sfcSections: 닫히지 않은 블록도 끝까지 구간으로 잡는다', () => {
  const sections = sfcSections('<script>\nconst a = 1\n')
  assert.deepEqual(sections, [{ start: 1, end: 3, lang: 'javascript' }])
})

test('detectLanguage: 확장자로 언어를 고른다', () => {
  assert.equal(detectLanguage('src/App.vue'), 'vue')
  assert.equal(detectLanguage('a/b/main.ts'), 'javascript')
  assert.equal(detectLanguage('style.scss'), 'css')
  assert.equal(detectLanguage('ko.json'), 'json')
  assert.equal(detectLanguage('README.md'), 'plain')
})

test('buildSpans: 문법 토큰과 변경 구간이 걸쳐도 둘 다 살아난다', () => {
  const text = 'a === b'
  const tokens = resolvePlugin('javascript').tokenize(text, 0, text.length)
  // '=== b' 만 변경된 경우
  const spans = buildSpans(text, [[2, 7]], tokens)

  assert.equal(rendered(spans), text)
  assert.equal(spans.find((s) => s.text === '===').changed, true)
  assert.equal(spans.find((s) => s.text === '===').cls, 'operator')
  // 변경 구간 앞의 조각(`a `)은 색도 없고 변경도 아니다
  assert.equal(spans[0].changed, false)
  assert.equal(spans[0].cls, null)
})

test('buildSpans: 변경 구간이 없으면 changed는 모두 false', () => {
  const text = "const a = 'x'"
  const tokens = resolvePlugin('javascript').tokenize(text, 0, text.length)
  const spans = buildSpans(text, null, tokens)
  assert.equal(rendered(spans), text)
  assert.ok(spans.every((s) => !s.changed))
})

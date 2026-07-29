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

test('java 플러그인이 레지스트리에 있다', () => {
  // 등록을 빠뜨리면 화면은 조용히 색 없이 나온다 — 테스트로 잡는다
  assert.equal(resolvePlugin('java').id, 'java')
})

test('java: 애너테이션·타입·키워드를 구분한다', () => {
  const line = '@Override public ResponseEntity<RoomDto> getRoom(@PathVariable Long id) {'
  const spans = highlightLine('java', line, null, {})
  // 애너테이션은 코드가 아니라 표시다. 한 덩어리로 떨어져야 한다
  assert.equal(classOf(spans, '@Override'), 'entity')
  assert.equal(classOf(spans, '@PathVariable'), 'entity')
  assert.equal(classOf(spans, 'public'), 'keyword')
  assert.equal(classOf(spans, 'ResponseEntity'), 'type')
  assert.equal(classOf(spans, 'RoomDto'), 'type')
  assert.equal(classOf(spans, 'getRoom'), 'function')
  // 소문자 식별자는 타입이 아니다
  assert.equal(classOf(spans, 'id'), undefined)
})

test('java: 기본형은 타입, 리터럴은 키워드', () => {
  const spans = highlightLine('java', 'private static final boolean muted = false;', null, {})
  assert.equal(classOf(spans, 'boolean'), 'type')
  assert.equal(classOf(spans, 'false'), 'keyword')
  assert.equal(classOf(spans, 'private'), 'keyword')
})

test('java: 문자열·char·숫자·주석', () => {
  const spans = highlightLine('java', `String s = "a'b"; char c = 'x'; long n = 48_000L; // 끝`, null, {})
  assert.equal(classOf(spans, `"a'b"`), 'string', '문자열 안의 아포스트로피에 속으면 안 된다')
  assert.equal(classOf(spans, "'x'"), 'string')
  assert.equal(classOf(spans, '48_000L'), 'number')
  assert.equal(classOf(spans, '// 끝'), 'comment')
})

test('java: 주석 안의 따옴표에 속지 않는다', () => {
  const spans = highlightLine('java', "int x = 1; // don't split here", null, {})
  assert.equal(classOf(spans, "// don't split here"), 'comment')
})

test('java: 텍스트 블록과 hex/binary 리터럴', () => {
  const block = highlightLine('java', '        String sql = """', null, {})
  assert.equal(classOf(block, '"""'), 'string')
  const nums = highlightLine('java', 'int mask = 0xFF | 0b1010;', null, {})
  assert.equal(classOf(nums, '0xFF'), 'number')
  assert.equal(classOf(nums, '0b1010'), 'number')
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
  assert.equal(detectLanguage('src/main/java/RoomController.java'), 'java')
  assert.equal(detectLanguage('README.md'), 'plain')
  assert.equal(detectLanguage('.github/workflows/ci.yml'), 'yaml')
  assert.equal(detectLanguage('scripts/build.sh'), 'shell')
  assert.equal(detectLanguage('gradle.properties'), 'properties')
})

/**
 * 확장자가 없는 설정 파일들. 이름 자체가 형식이라 확장자 표로는 잡히지 않고,
 * 빠뜨리면 화면에 색 없이(plain) 조용히 나온다.
 */
test('detectLanguage: 이름으로 정해지는 설정 파일들', () => {
  assert.equal(detectLanguage('.gitignore'), 'ignore')
  assert.equal(detectLanguage('web/.prettierignore'), 'ignore')
  assert.equal(detectLanguage('.prettierrc'), 'json') // 내용이 JSON이다
  assert.equal(detectLanguage('.npmrc'), 'properties')
  assert.equal(detectLanguage('Jenkinsfile'), 'groovy')
  assert.equal(detectLanguage('build.gradle'), 'groovy')
  assert.equal(detectLanguage('deploy/Dockerfile'), 'docker')
  assert.equal(detectLanguage('.env'), 'properties')
  assert.equal(detectLanguage('.env.production'), 'properties') // 변형까지
  // 이름 규칙이 확장자보다 먼저다: .prettierrc는 rc 확장자가 아니라 JSON
  assert.equal(detectLanguage('a/b/.gitignore'), 'ignore')
})

test('새 플러그인들이 레지스트리에 등록돼 있다', () => {
  // 등록을 빠뜨리면 서버는 언어를 알려주는데 화면은 색 없이 나온다
  for (const id of ['yaml', 'shell', 'properties', 'ignore', 'docker', 'groovy']) {
    assert.equal(resolvePlugin(id).id, id, `${id} 미등록`)
  }
})

test('groovy: 선언적 파이프라인의 블록 이름을 칠한다', () => {
  // 자바 키워드가 한 줄도 없는 것이 Jenkinsfile이다 — DSL 이름이 곧 구조다
  const spans = highlightLine('groovy', "    stage('build') {", null, {})
  assert.equal(classOf(spans, 'stage'), 'directive')
  assert.equal(classOf(spans, "'build'"), 'string')
  assert.equal(classOf(highlightLine('groovy', '  agent any', null, {}), 'agent'), 'directive')
  assert.equal(classOf(highlightLine('groovy', '  agent any', null, {}), 'any'), 'keyword')
  // GString 보간
  assert.equal(classOf(highlightLine('groovy', 'sh "npm ${cmd}"', null, {}), '${cmd}'), 'interp')
})

test('yaml: 키·문자열·주석·불리언을 구분한다', () => {
  const spans = highlightLine('yaml', "  name: 'grmide'  # 이름", null, {})
  assert.equal(classOf(spans, '  name'), 'attr')
  assert.equal(classOf(spans, "'grmide'"), 'string')
  assert.equal(classOf(spans, '# 이름'), 'comment')
  // 값 안의 콜론은 키로 오해되지 않는다 (키는 줄 앞에서만)
  const url = highlightLine('yaml', '  url: http://a.b/c', null, {})
  assert.equal(classOf(url, '  url'), 'attr')
  assert.equal(url.filter((s) => s.cls === 'attr').length, 1)
})

test('shell: 따옴표 안의 #은 주석이 아니다', () => {
  const spans = highlightLine('shell', "echo '# not comment' # real", null, {})
  assert.equal(classOf(spans, "'# not comment'"), 'string')
  assert.equal(classOf(spans, '# real'), 'comment')
  assert.equal(classOf(highlightLine('shell', 'if [ -f "$x" ]; then', null, {}), 'if'), 'keyword')
})

test('properties/ignore/docker: 각자의 뼈대를 칠한다', () => {
  const env = highlightLine('properties', 'VITE_API=/api', null, {})
  assert.equal(classOf(env, 'VITE_API'), 'attr')

  const ig = highlightLine('ignore', '!dist/keep.js', null, {})
  assert.equal(classOf(ig, '!'), 'keyword')
  assert.equal(classOf(highlightLine('ignore', '# 주석', null, {}), '# 주석'), 'comment')

  const df = highlightLine('docker', 'FROM node:18 AS build', null, {})
  assert.equal(classOf(df, 'FROM'), 'keyword')
  // 지시어는 줄 앞에서만 — 중간의 AS는 칠하지 않는다
  assert.equal(classOf(df, 'AS'), undefined)
})

test('새 플러그인도 span을 이어붙이면 원본이 복원된다', () => {
  const lines = [
    "  name: 'x'  # c",
    'export PATH="$HOME/bin:$PATH"',
    '[section]',
    '**/node_modules/',
    'RUN npm ci && npm run build',
    '',
    '   ',
  ]
  for (const language of ['yaml', 'shell', 'properties', 'ignore', 'docker', 'groovy']) {
    for (const line of lines) {
      assert.equal(rendered(highlightLine(language, line, null, {})), line, `${language}: ${line}`)
    }
  }
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

test('java: javadoc 중간 줄도 주석으로 칠한다', () => {
  // 줄 단위 무상태라 블록 중간을 모르는 것이 원래 한계다. 자바는 파일마다
  // javadoc 이 붙어서 그 한계가 첫 화면부터 보인다 — 줄 모양으로 메운다.
  const mid = highlightLine('java', ' * 회의실 조회 API.', null, {})
  assert.equal(classOf(mid, '* 회의실 조회 API.'), 'comment')

  const close = highlightLine('java', ' */', null, {})
  assert.equal(classOf(close, '*/'), 'comment')

  const tag = highlightLine('java', '     * @param id 회의실 id', null, {})
  assert.equal(classOf(tag, '* @param id 회의실 id'), 'comment')

  // 곱셈은 왼쪽 피연산자가 같은 줄에 있으므로 이 규칙에 걸리지 않는다
  const math = highlightLine('java', 'int n = a * b;', null, {})
  assert.equal(classOf(math, '*'), 'operator')
})

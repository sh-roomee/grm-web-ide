import javascript from './languages/javascript.js'
import markup from './languages/markup.js'
import css from './languages/css.js'
import json from './languages/json.js'
import vue from './languages/vue.js'

/**
 * 문법 강조 플러그인 레지스트리.
 *
 * 플러그인 규약:
 *   {
 *     id: string,
 *     tokenize(line, start, end, ctx) -> [{ start, end, cls }]
 *   }
 *
 * - 오프셋은 줄 안의 절대 위치. 반환 배열은 오프셋 순으로 정렬되고 겹치지 않는다.
 * - `cls`는 `--tok-*` CSS 변수와 짝이 되는 이름이다 (style.css 참고).
 * - `ctx`는 `{ lineNo, sections }`. 한 파일에 여러 언어가 섞이는 경우에만 쓴다.
 *
 * 언어를 추가하려면 `languages/`에 파일을 하나 만들고 여기에 등록하면 된다.
 * 서버(`server/language.js`)의 확장자 표에도 같은 id를 추가해야 한다.
 */
const PLUGINS = new Map()

export function register(plugin) {
  PLUGINS.set(plugin.id, plugin)
  return plugin
}

;[javascript, markup, css, json, vue].forEach(register)

const PLAIN = { id: 'plain', tokenize: () => [] }

export function resolvePlugin(language) {
  return PLUGINS.get(language) ?? PLAIN
}

export const languages = () => [...PLUGINS.keys()]

/**
 * 문법 토큰(전경색)과 변경 구간(배경색)을 하나의 span 목록으로 합친다.
 *
 * 두 구간은 서로 걸친다. 예를 들어 `displayMode.type && !selected` 에서
 * 변경 구간이 `&& !selected` 이고 그 안에 연산자/식별자 토큰이 따로 있다.
 * 그래서 두 경계를 모두 모아 잘게 쪼갠 뒤 각 조각에 두 속성을 붙인다.
 *
 * @param {string} text 한 줄
 * @param {Array<[number, number]>|null} words 변경된 구간 (서버 diff 결과)
 * @param {Array<{start,end,cls}>} tokens 문법 토큰
 * @returns {Array<{text, cls, changed}>}
 */
export function buildSpans(text, words, tokens) {
  if (!text) return []

  const bounds = new Set([0, text.length])
  for (const [s, e] of words ?? []) {
    if (s > 0 && s < text.length) bounds.add(s)
    if (e > 0 && e < text.length) bounds.add(e)
  }
  for (const t of tokens) {
    if (t.start > 0 && t.start < text.length) bounds.add(t.start)
    if (t.end > 0 && t.end < text.length) bounds.add(t.end)
  }

  const cuts = [...bounds].sort((a, b) => a - b)
  const spans = []
  let ti = 0
  let wi = 0

  for (let k = 0; k < cuts.length - 1; k++) {
    const start = cuts[k]
    const stop = cuts[k + 1]

    while (ti < tokens.length && tokens[ti].end <= start) ti++
    while (wi < (words?.length ?? 0) && words[wi][1] <= start) wi++

    const token = tokens[ti]
    const word = words?.[wi]
    spans.push({
      text: text.slice(start, stop),
      cls: token && token.start <= start && token.end >= stop ? token.cls : null,
      changed: Boolean(word && word[0] <= start && word[1] >= stop),
    })
  }

  return spans
}

/** 한 줄을 바로 span 목록으로. DiffViewer가 쓰는 진입점. */
export function highlightLine(language, text, words, ctx) {
  if (!text) return []
  const tokens = resolvePlugin(language).tokenize(text, 0, text.length, ctx)
  return buildSpans(text, words, tokens)
}

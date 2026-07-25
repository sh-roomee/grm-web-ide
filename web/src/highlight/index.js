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
 * 문법 토큰(전경색), 변경 구간(배경색), 찾기 결과(강조)를 하나의 span 목록으로
 * 합친다.
 *
 * 세 구간은 서로 걸친다. 예를 들어 `displayMode.type && !selected` 에서
 * 변경 구간이 `&& !selected` 이고 그 안에 연산자/식별자 토큰이 따로 있으며,
 * 찾기 결과는 또 다른 경계로 잘린다. 그래서 모든 경계를 모아 잘게 쪼갠 뒤
 * 각 조각에 세 속성을 붙인다.
 *
 * @param {string} text 한 줄
 * @param {Array<[number, number]>|null} words 변경된 구간 (서버 diff 결과)
 * @param {Array<{start,end,cls}>} tokens 문법 토큰
 * @param {Array<[number, number]>|null} hits 찾기(Cmd+F) 결과 구간
 * @returns {Array<{text, cls, changed, hit}>}
 */
export function buildSpans(text, words, tokens, hits = null) {
  if (!text) return []

  const bounds = new Set([0, text.length])
  const addRange = ([s, e]) => {
    if (s > 0 && s < text.length) bounds.add(s)
    if (e > 0 && e < text.length) bounds.add(e)
  }
  for (const range of words ?? []) addRange(range)
  for (const range of hits ?? []) addRange(range)
  for (const t of tokens) addRange([t.start, t.end])

  const cuts = [...bounds].sort((a, b) => a - b)
  const spans = []
  let ti = 0
  let wi = 0
  let hi = 0

  for (let k = 0; k < cuts.length - 1; k++) {
    const start = cuts[k]
    const stop = cuts[k + 1]

    while (ti < tokens.length && tokens[ti].end <= start) ti++
    while (wi < (words?.length ?? 0) && words[wi][1] <= start) wi++
    while (hi < (hits?.length ?? 0) && hits[hi][1] <= start) hi++

    const token = tokens[ti]
    const word = words?.[wi]
    const hit = hits?.[hi]
    spans.push({
      text: text.slice(start, stop),
      cls: token && token.start <= start && token.end >= stop ? token.cls : null,
      changed: Boolean(word && word[0] <= start && word[1] >= stop),
      hit: Boolean(hit && hit[0] <= start && hit[1] >= stop),
    })
  }

  return spans
}

/** 문법 토큰만 뽑는다. 찾기 강조와 분리해 두면 타이핑마다 다시 계산하지 않는다. */
export function tokenizeLine(language, text, ctx) {
  if (!text) return []
  return resolvePlugin(language).tokenize(text, 0, text.length, ctx)
}

/** 한 줄을 바로 span 목록으로. */
export function highlightLine(language, text, words, ctx, hits = null) {
  if (!text) return []
  return buildSpans(text, words, tokenizeLine(language, text, ctx), hits)
}

/**
 * 한 줄에서 검색어가 나오는 구간을 찾는다. 대소문자 구분 없음, 정규식 아님.
 *
 * 정규식을 받지 않는 이유: 사용자가 치는 중간 상태(`(`, `[a-`)가 늘 오류가 되고,
 * 코드에서 찾고 싶은 문자열 자체가 대부분 특수문자를 포함한다.
 */
export function findRanges(text, query) {
  if (!text || !query) return null
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const out = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    out.push([at, at + needle.length])
    from = at + needle.length
  }
  return out.length ? out : null
}

import { pushToken, sticky, concatTokens } from '../scanner.js'
import javascript from './javascript.js'

/**
 * HTML / Vue 템플릿.
 *
 * 규칙 목록만으로는 안 되는 이유: 태그 안인지 밖인지에 따라 같은 글자가 다른
 * 뜻이 된다(`class`가 속성 이름인지 그냥 텍스트인지). 그래서 태그 안/밖 상태를
 * 들고 도는 작은 상태 기계로 짰다.
 *
 * Vue 디렉티브(`v-if`, `:class`, `@click`)의 값은 문자열이 아니라 JS 식이므로
 * javascript 플러그인에 넘긴다. `{{ }}` 안쪽도 마찬가지다.
 */

const RE = {
  comment: sticky(/<!--[\s\S]*?(?:-->|$)/),
  tagOpen: sticky(/<\/?[a-zA-Z][\w.:-]*/),
  tagClose: sticky(/\/?>/),
  directive: sticky(/(?:v-[\w:.-]+|[:@#][\w.$[\]-]+)/),
  attr: sticky(/[a-zA-Z_][\w.:-]*/),
  eq: sticky(/=/),
  quote: sticky(/"[^"]*"?|'[^']*'?/),
  entity: sticky(/&#?\w+;/),
  space: sticky(/\s+/),
  doctype: sticky(/<!\w+[^>]*>?/i),
}

// 여는 태그가 여러 줄에 걸쳐 있으면 이어지는 줄은 태그 "안"에서 시작한다.
// 상태를 줄 사이로 넘기지 않으므로, 줄 모양을 보고 되짚는다.
const RE_ATTR_CONTINUATION = /^\s*(?:v-[\w:.-]+|[:@#][\w.$[\]-]+|[a-zA-Z_][\w.:-]*\s*=|\/?>)/

function tryMatch(re, line, i, end) {
  re.lastIndex = i
  const m = re.exec(line)
  if (!m || m[0].length === 0 || i + m[0].length > end) return null
  return m[0]
}

function tokenize(line, start = 0, end = line.length) {
  const tokens = []
  let i = start
  let inTag = RE_ATTR_CONTINUATION.test(line.slice(start, end))
  let valueIsExpression = false

  while (i < end) {
    const comment = tryMatch(RE.comment, line, i, end)
    if (comment) {
      pushToken(tokens, i, i + comment.length, 'comment')
      i += comment.length
      continue
    }

    if (!inTag) {
      if (line.startsWith('{{', i)) {
        const close = line.indexOf('}}', i + 2)
        const inner = close === -1 || close > end ? end : close
        pushToken(tokens, i, i + 2, 'interp')
        concatTokens(tokens, javascript.tokenize(line, i + 2, inner))
        if (close !== -1 && close <= end - 2) pushToken(tokens, close, close + 2, 'interp')
        i = close === -1 ? end : Math.min(close + 2, end)
        continue
      }

      const doctype = tryMatch(RE.doctype, line, i, end)
      if (doctype) {
        pushToken(tokens, i, i + doctype.length, 'comment')
        i += doctype.length
        continue
      }

      const tag = tryMatch(RE.tagOpen, line, i, end)
      if (tag) {
        pushToken(tokens, i, i + tag.length, 'tag')
        i += tag.length
        inTag = true
        valueIsExpression = false
        continue
      }

      const entity = tryMatch(RE.entity, line, i, end)
      if (entity) {
        pushToken(tokens, i, i + entity.length, 'entity')
        i += entity.length
        continue
      }

      i++ // 그냥 텍스트
      continue
    }

    // --- 태그 안 ---
    const space = tryMatch(RE.space, line, i, end)
    if (space) {
      i += space.length
      continue
    }

    const close = tryMatch(RE.tagClose, line, i, end)
    if (close) {
      pushToken(tokens, i, i + close.length, 'tag')
      i += close.length
      inTag = false
      continue
    }

    const directive = tryMatch(RE.directive, line, i, end)
    if (directive) {
      pushToken(tokens, i, i + directive.length, 'directive')
      i += directive.length
      valueIsExpression = true
      continue
    }

    const attr = tryMatch(RE.attr, line, i, end)
    if (attr) {
      pushToken(tokens, i, i + attr.length, 'attr')
      i += attr.length
      valueIsExpression = false
      continue
    }

    if (tryMatch(RE.eq, line, i, end)) {
      pushToken(tokens, i, i + 1, 'punct')
      i += 1
      continue
    }

    const quoted = tryMatch(RE.quote, line, i, end)
    if (quoted) {
      if (valueIsExpression) {
        // 디렉티브 값은 JS 식이다. 따옴표만 문자열 색을 주고 안쪽은 넘긴다.
        const closed = quoted.length > 1 && quoted.at(-1) === quoted[0]
        const innerEnd = i + quoted.length - (closed ? 1 : 0)
        pushToken(tokens, i, i + 1, 'string')
        concatTokens(tokens, javascript.tokenize(line, i + 1, innerEnd))
        if (closed) pushToken(tokens, innerEnd, innerEnd + 1, 'string')
      } else {
        pushToken(tokens, i, i + quoted.length, 'string')
      }
      i += quoted.length
      continue
    }

    i++
  }

  return tokens
}

export default { id: 'markup', tokenize }

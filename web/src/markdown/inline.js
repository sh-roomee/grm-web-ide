/**
 * 마크다운 인라인 파서. 한 줄(또는 이어붙인 문단)을 노드 배열로 만든다.
 *
 * **문자열이 아니라 트리를 내놓는다.** HTML을 만들면 `v-html`로 심어야 하고,
 * 그러면 저장소 파일 내용이 그대로 DOM 스크립트가 된다 — 살균기를 붙여 막는
 * 대신 그 자리를 아예 만들지 않는다. Vue가 텍스트 노드로 그리므로 이스케이프는
 * 공짜다.
 *
 * 노드:
 *   {type:'text',   value}
 *   {type:'code',   value}            인라인 코드. 안쪽은 더 파싱하지 않는다
 *   {type:'strong', children}
 *   {type:'em',     children}
 *   {type:'strike', children}
 *   {type:'link',   href, children}
 *   {type:'image',  src, alt}
 *   {type:'break'}                    강제 줄바꿈
 */

/** 이 스킴만 링크로 만든다. javascript: 같은 것을 href에 넣지 않기 위해서다. */
const SAFE_SCHEME = /^(https?:|mailto:|#|\/|\.|[^:]*$)/i

/**
 * href로 내보낼 수 있는지 본다.
 *
 * 왜 필요한가: `[클릭](javascript:alert(1))` 은 마크다운으로 완전히 정상이다.
 * 트리를 그리므로 태그 주입은 막히지만 href 자체는 우리가 넣는 값이라 여기서 걸러야
 * 한다. 통과하지 못하면 링크를 포기하고 글자로 남긴다 — 조용히 지우면 문서 내용이
 * 사라진다.
 */
export function safeHref(href) {
  const v = String(href ?? '').trim()
  if (!v) return null
  // 볼 수 있는 글자만 통과시킨다. 제어문자(탭·개행·널)를 스킴 중간에 끼워 검사를
  // 피하는 수법이 있어서, 무엇을 막을지 세는 대신 무엇을 허용할지만 적는다.
  if (!/^[\x21-\x7e\u00a0-\uffff]+$/.test(v)) return null
  return SAFE_SCHEME.test(v) ? v : null
}

/** 여는 표시와 짝이 되는 닫는 표시를 찾는다. 없으면 -1. */
function findClose(text, from, mark) {
  let i = from
  while (i < text.length) {
    const at = text.indexOf(mark, i)
    if (at < 0) return -1
    if (text[at - 1] === '\\') {
      i = at + mark.length
      continue
    }
    return at
  }
  return -1
}

/**
 * `[텍스트](주소)` 의 괄호 끝을 찾는다. 주소 안에 괄호가 들어 있을 수 있어
 * (위키 주소가 대표적) 깊이를 센다.
 */
function findParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 링크 라벨 `[...]` 의 끝. 라벨 안에 이미지가 중첩될 수 있어 깊이를 센다. */
function findBracket(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 백슬래시 이스케이프를 실제 글자로 되돌린다. */
function unescape(text) {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
}

/**
 * 인라인 파싱.
 *
 * 순서가 중요하다. 코드 스팬을 가장 먼저 뗀다 — 백틱 안의 `*`나 `[`는 문법이
 * 아니라 글자다. 그다음 이미지·링크, 그다음 강조다.
 */
export function parseInline(src) {
  const text = String(src ?? '')
  const out = []
  let buf = ''

  const flush = () => {
    if (buf) {
      out.push({ type: 'text', value: unescape(buf) })
      buf = ''
    }
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]

    // 백슬래시 이스케이프는 버퍼에 그대로 담아 두고 flush에서 한 번에 되돌린다
    if (ch === '\\' && i + 1 < text.length) {
      buf += ch + text[i + 1]
      i += 2
      continue
    }

    // 강제 줄바꿈: 줄 끝의 공백 두 칸, 또는 역슬래시
    if (ch === '\n') {
      const hard = /( {2,}|\\)$/.test(buf)
      if (hard) buf = buf.replace(/( {2,}|\\)$/, '')
      flush()
      out.push(hard ? { type: 'break' } : { type: 'text', value: ' ' })
      i += 1
      continue
    }

    // 코드 스팬. 여는 백틱 개수와 같은 수의 백틱으로 닫는다 (``a ` b`` 를 위해)
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))[0]
      const close = text.indexOf(run, i + run.length)
      if (close > 0) {
        flush()
        // 규약: 양끝 공백 한 칸은 구분자라 벗긴다 (`` ` `` 처럼 백틱 자체를 쓸 때)
        let value = text.slice(i + run.length, close)
        if (/^ .* $/.test(value)) value = value.slice(1, -1)
        out.push({ type: 'code', value })
        i = close + run.length
        continue
      }
    }

    // 이미지 ![alt](src)
    if (ch === '!' && text[i + 1] === '[') {
      const endLabel = findBracket(text, i + 1)
      if (endLabel > 0 && text[endLabel + 1] === '(') {
        const endUrl = findParen(text, endLabel + 1)
        if (endUrl > 0) {
          const src = safeHref(stripTitle(text.slice(endLabel + 2, endUrl)))
          if (src) {
            flush()
            out.push({ type: 'image', src, alt: unescape(text.slice(i + 2, endLabel)) })
            i = endUrl + 1
            continue
          }
        }
      }
    }

    // 링크 [텍스트](주소)
    if (ch === '[') {
      const endLabel = findBracket(text, i)
      if (endLabel > 0 && text[endLabel + 1] === '(') {
        const endUrl = findParen(text, endLabel + 1)
        if (endUrl > 0) {
          const href = safeHref(stripTitle(text.slice(endLabel + 2, endUrl)))
          const label = text.slice(i + 1, endLabel)
          flush()
          if (href) out.push({ type: 'link', href, children: parseInline(label) })
          // 주소를 못 믿으면 링크를 버리고 글자로 남긴다
          else out.push(...parseInline(label))
          i = endUrl + 1
          continue
        }
      }
    }

    // 취소선 ~~
    if (ch === '~' && text[i + 1] === '~') {
      const close = findClose(text, i + 2, '~~')
      if (close > 0) {
        flush()
        out.push({ type: 'strike', children: parseInline(text.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }

    // 강조. ** 와 __ 가 굵게, * 와 _ 가 기울임.
    if (ch === '*' || ch === '_') {
      const double = text[i + 1] === ch
      const mark = double ? ch + ch : ch
      // 밑줄 하나는 낱말 안에서 문법이 아니다 (snake_case_이름 이 기울어지면 안 된다)
      const wordInner = ch === '_' && !double && /[\w]/.test(text[i - 1] ?? '')
      if (!wordInner) {
        const close = findClose(text, i + mark.length, mark)
        // 여는 표시 바로 뒤가 공백이면 강조가 아니다 (`a * b * c` 의 곱셈 기호)
        const inner = close > 0 ? text.slice(i + mark.length, close) : ''
        if (close > 0 && inner && !/^\s/.test(inner) && !/\s$/.test(inner)) {
          flush()
          out.push({ type: double ? 'strong' : 'em', children: parseInline(inner) })
          i = close + mark.length
          continue
        }
      }
    }

    /**
     * 맨 URL 자동 링크 (GFM).
     *
     * 문서에 주소를 그냥 적는 일이 많다 — README 의 GitHub 첨부 영상 URL 이 그렇다
     * (마크다운으로 감싸면 GitHub 이 플레이어로 바꿔 주지 않아서 맨 URL 로 둬야 한다).
     * 그걸 글자로만 남기면 미리보기에서 누를 수 없는 긴 문자열이 된다.
     *
     * 앞이 낱말 중간이면 건드리지 않는다 — `see:https://x` 는 붙여 쓴 것이지만
     * `abchttps://x` 처럼 식별자 안에 든 것을 링크로 만들면 안 된다.
     */
    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(text.slice(i))) {
      const prev = text[i - 1]
      if (!prev || !/[\w./-]/.test(prev)) {
        const raw = /^https?:\/\/[^\s<>"'`]+/i.exec(text.slice(i))[0]
        const url = trimUrlTail(raw)
        const href = safeHref(url)
        if (href && url.length > 'https://'.length) {
          flush()
          out.push({ type: 'link', href, children: [{ type: 'text', value: url }] })
          i += url.length
          continue
        }
      }
    }

    // <http://...> 자동 링크
    if (ch === '<') {
      const close = text.indexOf('>', i)
      const body = close > 0 ? text.slice(i + 1, close) : ''
      if (close > 0 && /^(https?:\/\/|mailto:)[^\s<>]+$/i.test(body)) {
        flush()
        out.push({ type: 'link', href: body, children: [{ type: 'text', value: body }] })
        i = close + 1
        continue
      }
    }

    buf += ch
    i += 1
  }

  flush()
  return out
}

/**
 * 맨 URL 의 꼬리를 문장에서 떼어낸다 (GFM 규칙).
 *
 * `자세히는 https://example.com/a.` 에서 마지막 점은 문장의 것이고 주소가 아니다.
 * 괄호는 개수를 세어 짝이 맞는 것만 남긴다 — 위키 주소에 괄호가 들어가지만
 * `(https://example.com)` 처럼 감싼 괄호는 주소가 아니다.
 */
function trimUrlTail(url) {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    if ('.,;:!?’\'"*_~'.includes(ch)) {
      end -= 1
      continue
    }
    if (ch === ')') {
      const slice = url.slice(0, end)
      const opens = (slice.match(/\(/g) ?? []).length
      const closes = (slice.match(/\)/g) ?? []).length
      if (closes > opens) {
        end -= 1
        continue
      }
    }
    break
  }
  return url.slice(0, end)
}

/**
 * `(주소 "제목")` 에서 제목을 떼고 주소만 남긴다.
 *
 * 제목은 그리지 않는다. 툴팁은 읽는 데 도움이 안 되고, 넣으면 title 속성 하나가
 * 늘 뿐이다.
 */
function stripTitle(target) {
  const v = String(target ?? '').trim()
  const m = /^(\S+)\s+["'(].*$/.exec(v)
  return m ? m[1] : v
}

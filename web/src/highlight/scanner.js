/**
 * 언어 플러그인이 공통으로 쓰는 규칙 기반 토크나이저.
 *
 * 규칙은 순서가 곧 우선순위다. 각 위치에서 앞선 규칙부터 시도해 처음 맞는
 * 규칙이 이긴다. 아무 규칙도 안 맞으면 한 글자 넘어가고 그 글자는 색이 없다.
 *
 * 한 줄 단위로만 동작한다(여러 줄에 걸친 상태를 갖지 않는다). diff는 파일의
 * 조각만 보여주므로 애초에 완전한 문맥이 없고, 줄 단위로 끊는 편이 훨씬
 * 단순하다. 대가로 여러 줄 주석이나 템플릿 리터럴은 가끔 틀리게 칠해진다.
 */

/** 인접한 같은 종류 토큰을 합쳐 span 수를 줄인다. */
export function pushToken(tokens, start, end, cls) {
  if (!cls || end <= start) return
  const last = tokens[tokens.length - 1]
  if (last && last.cls === cls && last.end === start) last.end = end
  else tokens.push({ start, end, cls })
}

/** 정규식을 sticky(y)로 다시 컴파일한다. 위치를 지정해 매칭하기 위함이다. */
export function sticky(re) {
  const flags = re.flags.replace(/[gy]/g, '') + 'y'
  return new RegExp(re.source, flags)
}

/**
 * @param {Array<{re: RegExp, cls: string|null}>} rules
 * @returns {(line: string, offset?: number, end?: number) => Array<{start,end,cls}>}
 */
export function createScanner(rules) {
  const compiled = rules.map(({ re, cls }) => ({ cls, re: sticky(re) }))

  return function scan(line, offset = 0, end = line.length) {
    const tokens = []
    let i = offset
    while (i < end) {
      let advanced = 0
      for (const { cls, re } of compiled) {
        re.lastIndex = i
        const m = re.exec(line)
        if (m && m[0].length > 0 && i + m[0].length <= end) {
          pushToken(tokens, i, i + m[0].length, cls)
          advanced = m[0].length
          break
        }
      }
      i += advanced || 1
    }
    return tokens
  }
}

/** 다른 언어의 토큰 목록을 그대로 이어붙인다. 이미 절대 오프셋을 쓰므로 보정은 없다. */
export function concatTokens(target, tokens) {
  for (const t of tokens) pushToken(target, t.start, t.end, t.cls)
  return target
}

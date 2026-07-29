import { createScanner } from '../scanner.js'

/**
 * Groovy / Jenkinsfile.
 *
 * java 플러그인을 그대로 쓰면 Jenkinsfile은 거의 색이 없다. 선언적 파이프라인은
 * 자바 키워드가 한 줄도 안 나오고 `pipeline { agent any; stages { stage('x') } }`
 * 처럼 **DSL 블록 이름**으로만 이루어지기 때문이다. 그 이름들이 곧 구조라서,
 * 여기서는 그것들을 키워드로 본다.
 */

const KEYWORDS =
  'as|assert|break|case|catch|class|const|continue|def|default|do|else|enum|extends|' +
  'finally|for|goto|if|implements|import|in|instanceof|interface|new|package|' +
  'private|protected|public|return|static|super|switch|this|throw|throws|trait|' +
  'try|while|final|abstract|synchronized|native|transient|volatile|strictfp|threadsafe'

/** 선언적 파이프라인의 뼈대. Jenkinsfile을 읽을 때 눈이 먼저 찾는 것들이다. */
const PIPELINE =
  'pipeline|agent|stages|stage|steps|environment|options|parameters|triggers|tools|' +
  'post|always|success|failure|unstable|changed|aborted|cleanup|when|script|matrix|' +
  'axes|axis|input|parallel|node|library|libraries'

const LITERALS = 'true|false|null|any|none'

const scan = createScanner([
  { re: /\/\/.*/, cls: 'comment' },
  { re: /\/\*[\s\S]*?(?:\*\/|$)/, cls: 'comment' },

  // 삼중 따옴표(여러 줄 문자열). 줄 단위라 여는 줄만 알아본다
  { re: /'''[\s\S]*?(?:'''|$)/, cls: 'string' },
  { re: /"""[\s\S]*?(?:"""|$)/, cls: 'string' },
  { re: /"(?:\\.|[^"\\])*"?/, cls: 'string' },
  { re: /'(?:\\.|[^'\\])*'?/, cls: 'string' },
  { re: /\/(?:\\.|[^/\\\s])+\//, cls: 'string' }, // 슬래시 문자열 (/path/${x}/)

  { re: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[lLfFdDgG]?\b/, cls: 'number' },
  { re: /@\s*[A-Za-z_$][\w$.]*/, cls: 'entity' }, // @Library, @Grab

  { re: new RegExp(`\\b(?:${LITERALS})\\b`), cls: 'keyword' },
  { re: new RegExp(`\\b(?:${PIPELINE})\\b`), cls: 'directive' },
  { re: new RegExp(`\\b(?:${KEYWORDS})\\b`), cls: 'keyword' },

  { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/, cls: 'function' },
  { re: /\b[A-Z][\w$]*/, cls: 'type' },

  { re: /[A-Za-z_$][\w$]*/, cls: null },
  { re: /[{}()[\];,.]/, cls: 'punct' },
  { re: /[+\-*/%=<>!&|?:^~]+/, cls: 'operator' },
])

// javadoc/groovydoc 중간 줄 — java 플러그인과 같은 이유다
const DOC_CONTINUATION = /^(\s*)\*/

const GSTRING = /\$\{[^}]*\}|\$[\w.]+/g

/**
 * GString 보간을 문자열 토큰에서 떼어낸다.
 *
 * 문자열 규칙이 `"npm ${cmd}"`를 통째로 삼키기 때문에 후처리로 쪼갠다.
 * Jenkinsfile은 `sh "docker push ${IMAGE}:${TAG}"`처럼 값이 대부분 보간이라,
 * 통째로 한 색이면 정작 중요한 부분이 안 보인다. 작은따옴표 문자열은 Groovy에서
 * 보간이 없으므로 건드리지 않는다.
 */
function splitInterpolation(line, tokens) {
  const out = []
  for (const t of tokens) {
    if (t.cls !== 'string' || line[t.start] !== '"') {
      out.push(t)
      continue
    }
    let at = t.start
    GSTRING.lastIndex = t.start
    let m
    while ((m = GSTRING.exec(line)) && m.index < t.end) {
      const stop = Math.min(m.index + m[0].length, t.end)
      if (m.index > at) out.push({ start: at, end: m.index, cls: 'string' })
      out.push({ start: m.index, end: stop, cls: 'interp' })
      at = stop
    }
    if (at < t.end) out.push({ start: at, end: t.end, cls: 'string' })
  }
  return out
}

export default {
  id: 'groovy',
  tokenize: (line, start, end) => {
    const slice = line.slice(start, end)
    const doc = DOC_CONTINUATION.exec(slice)
    if (doc) return [{ start: start + doc[1].length, end, cls: 'comment' }]
    return splitInterpolation(line, scan(line, start, end))
  },
}

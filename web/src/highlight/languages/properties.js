import { createScanner } from '../scanner.js'

/**
 * KEY=VALUE 계열 — .env, .npmrc, .ini, .toml, .editorconfig.
 *
 * 키 규칙은 줄 앞에만 건다(sticky라 ^는 0에서만 맞는다). 값 안의 `host:port`
 * 같은 것을 키로 칠하지 않기 위해서다.
 */
const scan = createScanner([
  { re: /^\s*[#;].*/, cls: 'comment' },
  { re: /^\s*\[[^\]]*\]/, cls: 'type' }, // [section]
  { re: /^(?:export\s+)?[A-Za-z_][\w.-]*(?=\s*[=:])/, cls: 'attr' },
  { re: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/, cls: 'string' },
  { re: /\b(?:true|false)\b/, cls: 'keyword' },
  { re: /\b-?\d+(?:\.\d+)?\b/, cls: 'number' },
  { re: /[=:]/, cls: 'operator' },
])

export default { id: 'properties', tokenize: (line, start, end) => scan(line, start, end) }

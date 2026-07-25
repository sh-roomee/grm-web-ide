import { createScanner } from '../scanner.js'

const scan = createScanner([
  { re: /\/\*[\s\S]*?(?:\*\/|$)/, cls: 'comment' },
  { re: /"[^"]*"?|'[^']*'?/, cls: 'string' },
  { re: /@[\w-]+/, cls: 'keyword' },
  { re: /!important/, cls: 'keyword' },

  // scss/less 변수와 css 커스텀 프로퍼티
  { re: /--[\w-]+|\$[\w-]+|@[\w-]+/, cls: 'variable' },
  { re: /\bvar\(/, cls: 'function' },

  // 선언부의 속성 이름 (`display: flex`)
  { re: /[a-zA-Z-]+(?=\s*:)/, cls: 'attr' },

  { re: /#[0-9a-fA-F]{3,8}\b/, cls: 'number' },
  { re: /\b\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt)?\b/, cls: 'number' },

  // 선택자
  { re: /[.#][\w-]+/, cls: 'selector' },
  { re: /::?[\w-]+/, cls: 'selector' },
  { re: /\b[a-zA-Z_$][\w-]*(?=\s*\()/, cls: 'function' },

  { re: /[{}();,]/, cls: 'punct' },
  { re: /[>+~*]/, cls: 'operator' },
])

export default { id: 'css', tokenize: (line, start, end) => scan(line, start, end) }

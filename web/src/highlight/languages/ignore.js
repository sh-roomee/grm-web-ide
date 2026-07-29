import { createScanner } from '../scanner.js'

// .gitignore류 — 주석, 부정(!), 글롭 메타문자만 갈라 줘도 훨씬 읽힌다
const scan = createScanner([
  { re: /^\s*#.*/, cls: 'comment' },
  { re: /^!/, cls: 'keyword' },
  { re: /\*\*|[*?]|\[[^\]]*\]/, cls: 'operator' },
  { re: /\//, cls: 'punct' },
])

export default { id: 'ignore', tokenize: (line, start, end) => scan(line, start, end) }

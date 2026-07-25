import { createScanner } from '../scanner.js'

const scan = createScanner([
  { re: /\/\/.*/, cls: 'comment' }, // jsonc
  { re: /"(?:\\.|[^"\\])*"(?=\s*:)/, cls: 'attr' }, // 키
  { re: /"(?:\\.|[^"\\])*"?/, cls: 'string' },
  { re: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, cls: 'number' },
  { re: /\b(?:true|false|null)\b/, cls: 'keyword' },
  { re: /[{}[\],:]/, cls: 'punct' },
])

export default { id: 'json', tokenize: (line, start, end) => scan(line, start, end) }

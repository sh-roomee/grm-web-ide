import { createScanner } from '../scanner.js'

// 키는 줄 앞에서만 잡는다 — 값 안의 `http://x`의 x를 키로 칠하지 않는다
const scan = createScanner([
  { re: /^---$|^\.\.\.$/, cls: 'punct' },
  { re: /^\s*(?:-\s+)?[\w."'-]+(?=\s*:(?:\s|$))/, cls: 'attr' },
  { re: /"(?:\\.|[^"\\])*"?|'(?:''|[^'])*'?/, cls: 'string' },
  { re: /#.*/, cls: 'comment' },
  { re: /[&*][\w-]+/, cls: 'entity' }, // 앵커 · 별칭
  { re: /\b(?:true|false|null|yes|no|on|off)\b/i, cls: 'keyword' },
  { re: /\b-?\d+(?:\.\d+)?\b/, cls: 'number' },
  { re: /[:>|[\]{},]|-(?=\s|$)/, cls: 'punct' },
])

export default { id: 'yaml', tokenize: (line, start, end) => scan(line, start, end) }

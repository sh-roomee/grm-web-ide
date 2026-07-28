import { parseInline } from './inline.js'

/**
 * 마크다운 블록 파서. 파일 텍스트를 블록 트리로 만든다.
 *
 * 이 파서의 목표는 CommonMark 완전 구현이 아니다. **개발 문서에 실제로 쓰이는
 * 문법**만 다룬다 — 이 저장소의 `docs/`와 `README.md`가 곧 시험지다.
 *
 * 블록:
 *   {type:'heading',   level, inline}
 *   {type:'paragraph', inline}
 *   {type:'code',      lang, code}
 *   {type:'list',      ordered, start, items:[{blocks}]}
 *   {type:'quote',     blocks}
 *   {type:'table',     align, head, rows}
 *   {type:'hr'}
 *
 * 원시 HTML은 그리지 않는다. `<div>` 를 그대로 심으면 `v-html`이 필요해지고 그
 * 순간 저장소 파일이 스크립트가 된다. HTML 주석은 버리고, 나머지 태그는 글자로
 * 남긴다 — 조용히 지우면 문서에서 내용이 사라진 것처럼 보인다.
 */

const FENCE = /^(\s*)(```+|~~~+)\s*([^\s`]*)/
const HEADING = /^(#{1,6})\s+(.*)$/
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)([-*+])(\s+)(.*)$/
const ORDERED = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/
const SETEXT = /^ {0,3}(=+|-+)\s*$/

/** 표 구분선: `|---|:--:|---:|` */
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

export function parseMarkdown(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n')
  return parseBlocks(text.split('\n'))
}

function isBlank(line) {
  return !line || /^\s*$/.test(line)
}

/** 줄 목록을 블록 배열로. 재귀 호출(인용·목록 항목 안)에서도 이 함수를 쓴다. */
function parseBlocks(lines) {
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (isBlank(line)) {
      i++
      continue
    }

    // 코드 펜스. 안쪽은 파싱하지 않는다 — 그게 코드 블록의 요점이다.
    const fence = FENCE.exec(line)
    if (fence) {
      const [, indent, marker, info] = fence
      const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
      const body = []
      i++
      while (i < lines.length && !close.test(lines[i])) {
        // 펜스가 들여쓰여 있으면 같은 만큼 벗긴다 (목록 안의 코드 블록)
        body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i])
        i++
      }
      i++ // 닫는 펜스
      blocks.push({ type: 'code', lang: info.toLowerCase(), code: body.join('\n') })
      continue
    }

    // HTML 주석은 통째로 버린다. 문서에 자주 있고 보여줄 것이 없다.
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !/-->/.test(lines[i])) i++
      i++
      continue
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      // 닫는 #### 은 장식이라 뗀다
      const body = heading[2].replace(/\s+#+\s*$/, '')
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(body) })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body = []
      while (i < lines.length && (QUOTE.test(lines[i]) || (body.length && !isBlank(lines[i])))) {
        const m = QUOTE.exec(lines[i])
        body.push(m ? m[1] : lines[i]) // 인용 안의 이어지는 줄(> 없는 lazy 줄)
        i++
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(body) })
      continue
    }

    const list = listAt(lines, i)
    if (list) {
      blocks.push(list.block)
      i = list.next
      continue
    }

    // 표: 지금 줄이 머리, 다음 줄이 구분선일 때만 표다.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      const table = tableAt(lines, i)
      if (table) {
        blocks.push(table.block)
        i = table.next
        continue
      }
    }

    // 문단. 빈 줄이나 다른 블록이 시작될 때까지 모은다.
    const para = []
    while (i < lines.length && !isBlank(lines[i])) {
      const cur = lines[i]

      // setext 제목: 문단 바로 다음 줄이 === 나 --- 이면 그 문단이 제목이다.
      // (앞에 빈 줄이 있으면 위에서 HR로 이미 걸러졌다)
      if (para.length && SETEXT.test(cur)) {
        blocks.push({
          type: 'heading',
          level: cur.trim().startsWith('=') ? 1 : 2,
          inline: parseInline(para.join('\n')),
        })
        i++
        para.length = 0
        break
      }

      // 문단 중간에서 다른 블록이 시작되면 문단을 끊는다
      if (para.length && (FENCE.test(cur) || HEADING.test(cur) || HR.test(cur) || QUOTE.test(cur))) {
        break
      }
      if (para.length && (BULLET.test(cur) || ORDERED.test(cur))) break

      para.push(cur)
      i++
    }
    if (para.length) blocks.push({ type: 'paragraph', inline: parseInline(para.join('\n')) })
  }

  return blocks
}

/** 목록 표시를 읽는다. 목록이 아니면 null. */
function markerAt(line) {
  const b = BULLET.exec(line)
  if (b) {
    // `- - -` 은 구분선이지 목록이 아니다
    if (HR.test(line)) return null
    return { indent: b[1].length, ordered: false, content: b[4], width: b[1].length + 1 + b[3].length }
  }
  const o = ORDERED.exec(line)
  if (o) {
    return {
      indent: o[1].length,
      ordered: true,
      start: Number(o[2]),
      content: o[5],
      width: o[1].length + o[2].length + 1 + o[4].length,
    }
  }
  return null
}

/**
 * 목록 하나를 읽는다.
 *
 * 항목의 내용은 다시 `parseBlocks`로 돌린다 — 그래서 중첩 목록, 항목 안의 코드
 * 블록, 여러 문단이 저절로 된다. 들여쓰기를 벗긴 줄 목록을 만들어 넘기는 것이
 * 전부다.
 */
function listAt(lines, from) {
  const first = markerAt(lines[from])
  if (!first) return null

  const items = []
  let i = from
  let cur = null

  while (i < lines.length) {
    const line = lines[i]

    if (isBlank(line)) {
      // 빈 줄 뒤에 목록이 이어지지 않으면 목록이 끝난다
      const next = lines[i + 1]
      const nextMarker = next != null ? markerAt(next) : null
      const continues =
        next != null &&
        !isBlank(next) &&
        ((nextMarker && nextMarker.indent >= first.indent) ||
          leadingSpaces(next) > first.indent)
      if (!continues) break
      if (cur) cur.push('')
      i++
      continue
    }

    const marker = markerAt(line)

    // 같은 깊이의 새 항목
    if (marker && marker.indent <= first.indent) {
      // 종류가 바뀌면(불릿 → 번호) 다른 목록이다
      if (marker.ordered !== first.ordered) break
      cur = [marker.content]
      items.push(cur)
      i++
      continue
    }

    // 항목에 딸린 줄: 더 깊은 목록이거나 이어지는 본문
    if (cur && (marker || leadingSpaces(line) > first.indent)) {
      cur.push(line.slice(Math.min(leadingSpaces(line), first.width)))
      i++
      continue
    }

    // 표시 없이 바로 이어 쓴 줄 (lazy continuation)
    if (cur && !marker) {
      cur.push(line.trim())
      i++
      continue
    }

    break
  }

  if (!items.length) return null

  return {
    block: {
      type: 'list',
      ordered: first.ordered,
      start: first.ordered ? (first.start ?? 1) : null,
      items: items.map(taskItem),
    },
    next: i,
  }
}

/**
 * `- [x] 한 일` 을 체크 표시로 바꾼다.
 *
 * ROADMAP이 온통 이 문법이라 글자로 남기면 미리보기가 원문보다 읽기 어려워진다.
 * `checked`가 null이면 체크박스가 없는 보통 항목이다.
 */
function taskItem(item) {
  const lines = stripTrailingBlank(item)
  const task = /^\[([ xX])\](?:\s+(.*))?$/.exec(lines[0] ?? '')
  if (!task) return { checked: null, blocks: parseBlocks(lines) }
  lines[0] = task[2] ?? ''
  return { checked: task[1].toLowerCase() === 'x', blocks: parseBlocks(lines) }
}

function leadingSpaces(line) {
  return /^\s*/.exec(line)[0].replace(/\t/g, '    ').length
}

function stripTrailingBlank(item) {
  const out = item.slice()
  while (out.length && isBlank(out[out.length - 1])) out.pop()
  return out
}

/** `| a | b |` 를 칸 배열로. 이스케이프한 `\|` 는 칸을 나누지 않는다. */
function splitRow(line) {
  const cells = []
  let buf = ''
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '')
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') {
      buf += '|'
      i++
      continue
    }
    if (ch === '`') {
      // 코드 스팬 안의 파이프는 칸을 나누지 않는다. 다만 표 안에서는 코드 안에서도
      // `\|` 로 써야 하므로(GFM), 벗겨서 넘겨야 화면에 역슬래시가 남지 않는다.
      const close = body.indexOf('`', i + 1)
      if (close > 0) {
        buf += body.slice(i, close + 1).replace(/\\\|/g, '|')
        i = close
        continue
      }
    }
    if (ch === '|') {
      cells.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

function tableAt(lines, from) {
  const head = splitRow(lines[from])
  const align = splitRow(lines[from + 1]).map((spec) => {
    const left = spec.startsWith(':')
    const right = spec.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
  // 머리와 구분선의 칸 수가 다르면 표가 아니다 (본문에 섞인 파이프)
  if (head.length !== align.length) return null

  const rows = []
  let i = from + 2
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
    const cells = splitRow(lines[i])
    // 칸이 부족하거나 넘치면 머리 개수에 맞춘다. 넘치는 칸을 버리면 내용이
    // 사라지므로 마지막 칸에 붙인다.
    while (cells.length < head.length) cells.push('')
    if (cells.length > head.length) {
      const extra = cells.splice(head.length).join(' | ')
      cells[head.length - 1] += ` | ${extra}`
    }
    rows.push(cells.map(parseInline))
    i++
  }

  return {
    block: { type: 'table', align, head: head.map(parseInline), rows },
    next: i,
  }
}

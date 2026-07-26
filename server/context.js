import path from 'node:path'

/**
 * AI에게 "이것도 같이 봐" 하고 넘길 컨텍스트 바구니.
 *
 * 리뷰 코멘트가 **판단**을 넘기는 길이라면, 이쪽은 **읽을 곳**을 넘기는 길이다.
 * 지금까지는 사람이 터미널에 경로를 손으로 쳤고, 줄 범위는 대충 말로 설명했다.
 *
 * 담는 것은 세 가지다.
 *
 *  - `file`  파일 하나 전체
 *  - `range` 파일의 한 구간 (diff에서 끌어 고른 줄들)
 *  - `grep`  검색어. 프롬프트를 만들 때 **그 자리에서 다시 검색한다** —
 *            담아 둔 결과를 얼려 두면 AI가 고친 뒤에는 사실과 달라진다
 *
 * 내용을 담을 때가 아니라 **넘길 때** 읽는 이유가 그것이다. 바구니는 "무엇을
 * 볼지"만 들고 있고, 실제 내용은 프롬프트를 만드는 순간의 파일에서 온다.
 */

const EXT_FENCE = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.css': 'css',
  '.scss': 'scss',
  '.json': 'json',
  '.md': 'md',
  '.html': 'html',
  '.py': 'python',
  '.go': 'go',
  '.sh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
}

const fenceFor = (filePath) => EXT_FENCE[path.extname(filePath ?? '').toLowerCase()] ?? ''

/** 파일 하나에서 가져갈 최대 줄 수. 컨텍스트 창을 통째로 먹는 것을 막는다. */
export const MAX_FILE_LINES = 600
/** 검색 결과는 이만큼만. 나머지는 개수로 알린다. */
export const MAX_GREP_HITS = 40

/** 바구니에 넣을 항목을 정규화한다. 모양이 어긋난 것은 null. */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null

  if (raw.kind === 'grep') {
    const query = String(raw.query ?? '').trim().slice(0, 200)
    return query ? { kind: 'grep', query } : null
  }

  const relPath = String(raw.path ?? '').trim()
  if (!relPath) return null

  if (raw.kind === 'range') {
    const line = Number(raw.line)
    if (!Number.isInteger(line) || line < 1) return null
    const endRaw = Number(raw.endLine)
    const endLine = Number.isInteger(endRaw) && endRaw > line ? endRaw : line
    return { kind: 'range', path: relPath, line, endLine }
  }

  return { kind: 'file', path: relPath }
}

/** 같은 것을 두 번 담지 않게 하는 열쇠. */
export function itemKey(item) {
  if (item.kind === 'grep') return `grep:${item.query}`
  if (item.kind === 'range') return `range:${item.path}:${item.line}-${item.endLine}`
  return `file:${item.path}`
}

/** 화면과 프롬프트에서 같은 이름을 쓴다. */
export function itemLabel(item) {
  if (item.kind === 'grep') return `검색: "${item.query}"`
  if (item.kind === 'range') {
    return item.endLine > item.line
      ? `${item.path}:${item.line}-${item.endLine}`
      : `${item.path}:${item.line}`
  }
  return item.path
}

/**
 * 프롬프트를 만든다.
 *
 * @param items   바구니 항목
 * @param sources Map<itemKey, { lines?: string[], missing?: boolean, hits?: [], total?: number }>
 *                파일 읽기와 검색은 호출한 쪽이 한다 (서버만 할 수 있는 일이라)
 */
export function buildContextPrompt(items, sources) {
  if (!items.length) return ''

  const out = ['아래 파일을 참고해줘. 지금 내가 보고 있는 곳이다.', '']

  for (const item of items) {
    const source = sources.get(itemKey(item)) ?? {}
    out.push(`## ${itemLabel(item)}`)
    out.push('')

    if (item.kind === 'grep') {
      const hits = source.hits ?? []
      if (!hits.length) {
        out.push('_결과 없음_')
      } else {
        out.push('```')
        for (const hit of hits.slice(0, MAX_GREP_HITS)) {
          out.push(`${hit.path}:${hit.line}: ${hit.text}`)
        }
        out.push('```')
        if ((source.total ?? hits.length) > MAX_GREP_HITS) {
          out.push(`_그 외 ${source.total - MAX_GREP_HITS}건_`)
        }
      }
      out.push('')
      continue
    }

    if (source.missing || !source.lines) {
      out.push('_파일을 읽을 수 없다_')
      out.push('')
      continue
    }

    const fence = fenceFor(item.path)
    const lines = source.lines
    const shown = lines.slice(0, MAX_FILE_LINES)

    out.push('```' + fence)
    out.push(shown.join('\n'))
    out.push('```')
    if (lines.length > MAX_FILE_LINES) {
      // 잘랐다는 사실을 감추면 AI가 "여기 없다"를 근거로 잘못 판단한다
      out.push(`_${lines.length}줄 중 앞 ${MAX_FILE_LINES}줄만 담았다_`)
    }
    out.push('')
  }

  return out.join('\n').trimEnd() + '\n'
}

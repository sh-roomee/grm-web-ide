/**
 * unified diff 텍스트를 side-by-side 렌더링용 구조로 변환한다.
 *
 * 브라우저가 아니라 서버에서 변환하는 이유:
 *  - 파싱/단어 diff 비용을 클라이언트에 얹지 않는다 (44개 파일 diff가 흔하다)
 *  - 순수 함수라 테스트가 쉽다
 */

const MAX_ROWS = 20000 // 이 이상은 브라우저가 감당 못하므로 잘라낸다
const MAX_WORD_DIFF_TOKENS = 400 // 미니파이된 한 줄에 LCS를 돌리면 멈춘다

/** 단어 diff용 토큰화. 공백/식별자/기호 단위로 쪼갠다. */
function tokenize(line) {
  return line.match(/\s+|[A-Za-z0-9_$]+|[^\s A-Za-z0-9_$]/g) ?? []
}

/**
 * LCS 테이블 기반 토큰 diff.
 *
 * 결과를 문자열 조각이 아니라 **오프셋 구간** `[[start, end], ...]`으로 돌려준다.
 * 클라이언트에서 문법 강조 토큰(전경색)과 변경 구간(배경색)을 하나의 span
 * 목록으로 합쳐야 하는데, 두 구간이 서로 걸치므로 오프셋이 아니면 합칠 수 없다.
 */
function wordDiff(oldLine, newLine) {
  const a = tokenize(oldLine)
  const b = tokenize(newLine)
  if (a.length > MAX_WORD_DIFF_TOKENS || b.length > MAX_WORD_DIFF_TOKENS) return null

  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const left = []
  const right = []
  let leftPos = 0
  let rightPos = 0

  // 붙어 있는 변경 구간은 하나로 합친다 (span 수를 줄인다)
  const mark = (ranges, start, end) => {
    const last = ranges[ranges.length - 1]
    if (last && last[1] === start) last[1] = end
    else ranges.push([start, end])
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      leftPos += a[i++].length
      rightPos += b[j++].length
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      mark(left, leftPos, (leftPos += a[i++].length))
    } else {
      mark(right, rightPos, (rightPos += b[j++].length))
    }
  }
  while (i < a.length) mark(left, leftPos, (leftPos += a[i++].length))
  while (j < b.length) mark(right, rightPos, (rightPos += b[j++].length))

  return { left, right }
}

/**
 * 연속된 - 묶음과 + 묶음을 한 행에 짝지어 'mod' 행으로 만든다.
 * 개수가 안 맞는 나머지는 한쪽만 있는 행으로 흘린다.
 */
function pairBlock(dels, adds, rows) {
  const paired = Math.min(dels.length, adds.length)
  for (let k = 0; k < paired; k++) {
    const words = wordDiff(dels[k].text, adds[k].text)
    rows.push({
      type: 'mod',
      left: { num: dels[k].num, text: dels[k].text, words: words?.left ?? null },
      right: { num: adds[k].num, text: adds[k].text, words: words?.right ?? null },
    })
  }
  for (let k = paired; k < dels.length; k++) {
    rows.push({ type: 'del', left: { num: dels[k].num, text: dels[k].text }, right: null })
  }
  for (let k = paired; k < adds.length; k++) {
    rows.push({ type: 'add', left: null, right: { num: adds[k].num, text: adds[k].text } })
  }
}

/**
 * @param {string} raw - `git diff` 원문
 * @returns {{binary:boolean, truncated:boolean, hunks:Array, oldPath:string|null, newPath:string|null}}
 */
export function parseUnifiedDiff(raw) {
  // changes를 여기서 함께 초기화한다. 빈 diff에서 이 필드가 빠지면
  // 응답 모양이 달라져 클라이언트가 undefined를 만난다.
  const result = {
    binary: false,
    truncated: false,
    oldPath: null,
    newPath: null,
    changes: 0,
    hunks: [],
  }
  if (!raw) return result

  const lines = raw.split('\n')
  let hunk = null
  let oldNum = 0
  let newNum = 0
  let dels = []
  let adds = []
  let rowCount = 0

  const flush = () => {
    if (!hunk) return
    pairBlock(dels, adds, hunk.rows)
    dels = []
    adds = []
  }

  for (const line of lines) {
    // diff 본문의 모든 행은 ' ', '+', '-', '\' 중 하나로 시작한다. 빈 문자열은
    // 마지막 개행 때문에 생긴 잉여 원소이므로 컨텍스트 행으로 세면 안 된다.
    if (line === '') continue
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity index') || line.startsWith('rename ') || line.startsWith('deleted file') || line.startsWith('new file')) {
      continue
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      result.binary = true
      continue
    }
    if (line.startsWith('--- ')) {
      result.oldPath = line.slice(4).replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      result.newPath = line.slice(4).replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@')) {
      flush()
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line)
      if (!m) continue
      oldNum = Number(m[1])
      newNum = Number(m[3])
      hunk = {
        header: m[5] ?? '',
        oldStart: oldNum,
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: newNum,
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        rows: [],
      }
      result.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (rowCount >= MAX_ROWS) {
      result.truncated = true
      break
    }

    const marker = line[0]
    const text = line.slice(1)
    if (marker === '+') {
      adds.push({ num: newNum++, text })
      rowCount++
    } else if (marker === '-') {
      dels.push({ num: oldNum++, text })
      rowCount++
    } else if (marker === '\\') {
      // "\ No newline at end of file" — 렌더링에는 영향 없음
      continue
    } else {
      flush()
      hunk.rows.push({
        type: 'context',
        left: { num: oldNum++, text },
        right: { num: newNum++, text },
      })
      rowCount++
    }
  }
  flush()

  // 변경 행 수 요약 (뷰어 상단 "N differences" 표시용)
  for (const h of result.hunks) {
    h.changes = h.rows.filter((r) => r.type !== 'context').length
  }
  result.changes = result.hunks.reduce((sum, h) => sum + h.changes, 0)

  return result
}

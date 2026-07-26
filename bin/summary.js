import path from 'node:path'
import process from 'node:process'

/**
 * grmide를 실행한 터미널에 띄우는 요약.
 *
 * 주소만 찍고 끝내면 "브라우저를 봐야 뭐가 바뀐지 안다"가 된다. 이 도구를 쓰는
 * 사람은 터미널에 손을 두고 있으니, 열기 전에 규모를 알 수 있어야 한다.
 */

const FILE_LIST_LIMIT = 6

// 색은 TTY일 때만. 파이프로 넘기거나 NO_COLOR가 있으면 평문으로 둔다.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR

const paint = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text))
const c = {
  bold: paint('1'),
  dim: paint('2'),
  green: paint('32'),
  red: paint('31'),
  yellow: paint('33'),
  blue: paint('34'),
  cyan: paint('36'),
  magenta: paint('35'),
}

const STATUS_MARK = {
  modified: { char: 'M', color: c.blue },
  added: { char: 'A', color: c.green },
  deleted: { char: 'D', color: c.red },
  renamed: { char: 'R', color: c.blue },
  copied: { char: 'C', color: c.blue },
  typechange: { char: 'T', color: c.blue },
  untracked: { char: '?', color: c.magenta },
  conflicted: { char: '!', color: c.yellow },
}

/**
 * 터미널에서 차지하는 칸 수. 한글·한자·이모지는 두 칸이다.
 * `padEnd`는 글자 수로만 세서 한글 라벨이 섞이면 정렬이 어긋난다.
 */
function displayWidth(text) {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // 한글 자모
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK
      (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1f9ff) // 이모지
    width += wide ? 2 : 1
  }
  return width
}

function padTo(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

const LABEL_WIDTH = 8

function label(text) {
  return c.dim(padTo(text, LABEL_WIDTH))
}

/** 긴 커밋 제목은 잘라낸다. 터미널이 줄바꿈되면 요약이 아니게 된다. */
function truncate(text, max) {
  if (displayWidth(text) <= max) return text
  let out = ''
  for (const ch of text) {
    if (displayWidth(out) + displayWidth(ch) > max - 1) break
    out += ch
  }
  return `${out}…`
}

/**
 * 추가/삭제 줄 수. 줄 수를 셀 수 없는 것은 따로 표시한다.
 *
 * 심볼릭 링크를 "바이너리"로 세면 거짓말이 된다 — worktree 안의 `.claude` 링크처럼
 * 도구가 만든 링크가 매번 목록에 뜨는데 정체를 알 수 없게 된다.
 */
function countLines(files) {
  let additions = 0
  let deletions = 0
  let binary = 0
  let links = 0
  for (const f of files) {
    if (f.link) links += 1
    else if (f.additions === null || f.deletions === null) binary += 1
    additions += f.additions ?? 0
    deletions += f.deletions ?? 0
  }
  return { additions, deletions, binary, links }
}

function lineDelta({ additions, deletions, binary, links = 0 }, { countBinary = true } = {}) {
  const parts = []
  if (additions) parts.push(c.green(`+${additions}`))
  if (deletions) parts.push(c.red(`-${deletions}`))
  if (binary) parts.push(c.dim(countBinary ? `바이너리 ${binary}` : '바이너리'))
  if (links) parts.push(c.dim(countBinary ? `링크 ${links}` : '링크'))
  return parts.join(' ')
}

/**
 * @param {object} args
 * @param {string} args.repo   저장소 루트
 * @param {string} args.branch 브랜치 (또는 detached 표시)
 * @param {object|null} args.head HEAD 커밋 요약
 * @param {object} args.status /api/status 와 같은 모양
 * @param {string} args.url   브라우저 주소
 * @param {boolean} args.dev
 * @param {string} args.token
 */
export function renderSummary({ repo, branch, head, status, url, dev, token }) {
  const { staged, unstaged, conflicted } = status
  const all = [...conflicted, ...staged, ...unstaged]

  // 한 파일이 staged/unstaged 양쪽에 나올 수 있으므로 경로로 센다
  const uniquePaths = new Set(all.map((f) => f.path))
  const out = []

  out.push(`${c.bold('grmide')}  ${c.bold(path.basename(repo))}  ${c.cyan(`⎇ ${branch}`)}`)
  out.push(`${label('경로')}${c.dim(repo)}`)

  if (head) {
    const subject = truncate(head.subject, 60)
    out.push(`${label('HEAD')}${c.yellow(head.shortSha)} ${subject} ${c.dim(`· ${head.relativeDate}`)}`)
  } else {
    out.push(`${label('HEAD')}${c.dim('커밋 없음')}`)
  }

  if (uniquePaths.size === 0) {
    out.push(`${label('변경')}${c.dim('없음 — 워킹트리가 깨끗하다')}`)
  } else {
    const totals = countLines([...staged, ...unstaged])
    out.push(`${label('변경')}${c.bold(`${uniquePaths.size}개 파일`)}  ${lineDelta(totals)}`)

    const groups = []
    if (conflicted.length) groups.push(c.yellow(`충돌 ${conflicted.length}`))
    if (staged.length) groups.push(`staged ${staged.length}`)
    const tracked = unstaged.filter((f) => !f.untracked).length
    const untracked = unstaged.length - tracked
    if (tracked) groups.push(`unstaged ${tracked}`)
    if (untracked) groups.push(`untracked ${untracked}`)
    out.push(`${label('')}${c.dim(groups.join(' · '))}`)

    out.push('')
    const shown = all.slice(0, FILE_LIST_LIMIT)
    // 경로 길이가 제각각이라 그냥 이어붙이면 줄 수가 들쭉날쭉해진다
    const pathWidth = Math.min(56, Math.max(...shown.map((f) => displayWidth(f.path))))
    for (const file of shown) {
      const mark = STATUS_MARK[file.status] ?? { char: '·', color: c.dim }
      const stat = lineDelta(countLines([file]), { countBinary: false })
      const where = file.staged ? c.dim(' staged') : ''
      out.push(`  ${mark.color(mark.char)} ${padTo(truncate(file.path, pathWidth), pathWidth)}  ${stat}${where}`.trimEnd())
    }
    if (all.length > FILE_LIST_LIMIT) {
      out.push(c.dim(`  … 그 외 ${all.length - FILE_LIST_LIMIT}개`))
    }
  }

  out.push('')
  out.push(`${label('주소')}${url}`)
  if (dev) {
    out.push(`${label('')}${c.dim(`(dev) 프론트: http://localhost:5173/?t=${token}`)}`)
  }
  out.push(`${label('')}${c.dim('파일이 바뀌면 브라우저가 스스로 따라온다. Ctrl-C 로 종료.')}`)

  return out.join('\n')
}

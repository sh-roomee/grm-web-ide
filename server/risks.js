/**
 * AI가 만든 변경에서 **사람이 놓치기 쉬운 지점**을 찾아낸다.
 *
 * 리뷰에서 위험한 것은 새로 들어온 코드보다 **조용히 사라진 것**이다. 추가된 줄은
 * 눈에 띄지만, 지워진 테스트나 없어진 에러 처리는 44개 파일을 훑는 동안 그냥
 * 지나간다. 그래서 삭제된 줄을 먼저 본다.
 *
 * 린터가 아니다. "여기 한 번 보라"는 표시일 뿐이고, 틀릴 수 있다는 전제로 만든다 —
 * 그래서 판정을 내리지 않고 개수와 예시만 보여준다.
 */

/**
 * 여러 파일이 담긴 unified diff를 파일별 추가/삭제 줄로 쪼갠다.
 * `-U0`로 받은 출력을 전제로 한다(컨텍스트 줄이 없다).
 */
export function splitDiffFiles(raw) {
  const files = []
  let current = null

  for (const line of (raw ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      // `diff --git a/경로 b/경로` — 경로에 공백이 있을 수 있어 b/ 쪽을 잘라 쓴다
      const at = line.indexOf(' b/')
      const path = at === -1 ? null : line.slice(at + 3)
      current = { path, added: [], removed: [], binary: false }
      if (path) files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      current.binary = true
      continue
    }
    // 헤더 줄(+++ / ---)은 내용이 아니다
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
  }

  return files
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$/i
const LOCK_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i
const MANIFEST = /(^|\/)(package\.json|requirements\.txt|go\.mod|Gemfile|Cargo\.toml)$/i

// 테스트 한 건이 사라진 것을 알아보는 모양
const TEST_CASE = /\b(it|test|describe|context)\s*[.(]|\b(assert|expect)\s*[.(]/
// 에러 처리가 사라진 것을 알아보는 모양
const ERROR_HANDLING = /\b(try|catch|finally|throw|reject)\b|\.catch\s*\(|\bif\s*\(\s*err/
// 남겨진 디버그 출력
const DEBUG_OUTPUT = /\bconsole\.(log|debug|dir|trace)\s*\(|\bdebugger\b|\bprint\s*\(|\bfmt\.Print/

const LARGE_DELETION_LINES = 30
const LARGE_DELETION_RATIO = 4 // 삭제가 추가의 몇 배 이상일 때

/** 한 줄에서 앞뒤 공백을 걷고 길이를 자른다. 예시로만 쓴다. */
const sample = (line) => line.trim().slice(0, 120)

/**
 * 파일 하나의 위험 신호.
 * @returns [{ kind, label, count, samples }]
 */
export function analyzeFile({ path, added = [], removed = [], binary = false }) {
  if (binary) return []
  const risks = []

  const push = (kind, label, lines) => {
    if (!lines.length) return
    risks.push({ kind, label, count: lines.length, samples: lines.slice(0, 3).map(sample) })
  }

  // 1) 사라진 테스트 — 테스트 파일에서만 본다. 일반 코드의 `describe`는 다른 뜻일 수 있다.
  if (TEST_PATH.test(path)) {
    push(
      'test-removed',
      '삭제된 테스트',
      removed.filter((l) => TEST_CASE.test(l)),
    )
  }

  // 2) 사라진 에러 처리 — 추가된 쪽에 같은 모양이 있으면 옮긴 것일 수 있어 개수를 상계한다
  const removedGuards = removed.filter((l) => ERROR_HANDLING.test(l))
  const addedGuards = added.filter((l) => ERROR_HANDLING.test(l))
  if (removedGuards.length > addedGuards.length) {
    push('error-handling-removed', '사라진 에러 처리', removedGuards.slice(addedGuards.length))
  }

  // 3) 남겨진 디버그 출력 — 추가된 쪽만 본다.
  // 테스트 파일은 제외한다: 테스트에 남은 출력은 위험이 아니고, 디버그 출력을
  // 검사하는 테스트 자체가 걸려 잡음이 된다(실제로 이 저장소에서 겪었다).
  if (!TEST_PATH.test(path)) {
    push(
      'debug-added',
      '남은 디버그 출력',
      added.filter((l) => DEBUG_OUTPUT.test(l)),
    )
  }

  // 4) 의존성 변경 — 무엇이 들어오고 나갔는지는 사람이 봐야 한다
  if (MANIFEST.test(path) || LOCK_FILE.test(path)) {
    const changed = [...removed, ...added].filter((l) => /["']?[\w@/.-]+["']?\s*:\s*["']/.test(l))
    if (changed.length || LOCK_FILE.test(path)) {
      risks.push({
        kind: 'dependency',
        label: '의존성 변경',
        count: changed.length,
        samples: changed.slice(0, 3).map(sample),
      })
    }
  }

  // 5) 크게 지워짐 — 옮긴 것이 아니라 정말 없어졌을 수 있다
  if (
    removed.length >= LARGE_DELETION_LINES &&
    removed.length >= Math.max(1, added.length) * LARGE_DELETION_RATIO
  ) {
    risks.push({
      kind: 'large-deletion',
      label: '크게 지워짐',
      count: removed.length,
      samples: [`−${removed.length}줄 / +${added.length}줄`],
    })
  }

  return risks
}

/** 파일 목록 전체를 훑는다. 위험이 없는 파일은 결과에 넣지 않는다. */
export function analyzeRisks(files) {
  const byPath = {}
  let total = 0
  for (const file of files) {
    if (!file.path) continue
    const risks = analyzeFile(file)
    if (!risks.length) continue
    byPath[file.path] = risks
    total += risks.length
  }
  return { files: byPath, total, fileCount: Object.keys(byPath).length }
}

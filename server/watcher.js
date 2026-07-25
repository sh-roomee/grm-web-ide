import path from 'node:path'
import chokidar from 'chokidar'

const DEBOUNCE_MS = 200

// AI가 파일을 연달아 쓰는 동안 이벤트가 폭주하므로, 무거운 디렉토리는
// 아예 감시하지 않고 나머지는 디바운스로 묶는다.
const IGNORED = [
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])(dist|build|coverage|\.next|\.nuxt|\.venv|__pycache__)([/\\]|$)/,
  /(^|[/\\])\.DS_Store$/,
]

/**
 * 워크트리와 .git 메타데이터를 감시하고, 변경이 잠잠해지면 onChange를 부른다.
 *
 * .git 디렉토리 전체는 무시하되 index / HEAD / MERGE_HEAD는 따로 감시한다.
 * stage, 브랜치 전환, 머지 진입은 워킹트리 파일을 건드리지 않고도 화면을
 * 바꿔야 하는 이벤트이기 때문이다.
 */
export function createWatcher(repo, onChange) {
  const emit = debounce(onChange, DEBOUNCE_MS)

  const tree = chokidar.watch(repo, {
    ignored: IGNORED,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  })

  const meta = chokidar.watch(
    ['index', 'HEAD', 'MERGE_HEAD', 'ORIG_HEAD'].map((f) => path.join(repo, '.git', f)),
    { ignoreInitial: true, persistent: true },
  )

  for (const w of [tree, meta]) {
    w.on('all', () => emit())
    w.on('error', (err) => console.error('[grmide] watcher 오류:', err.message))
  }

  return {
    close: () => Promise.all([tree.close(), meta.close()]),
  }
}

function debounce(fn, ms) {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
}

import { computed, ref } from 'vue'

/**
 * 열어 둔 문서 탭.
 *
 * ⌘P로 아무 파일이나 열 수 있게 되면서, 한 번에 하나만 보는 구조로는 오갈 수가
 * 없어졌다. IDE의 에디터 탭과 같은 역할이다.
 *
 * 탭 종류:
 *  - `worktree` 워킹트리/staged 파일의 diff
 *  - `commit`   어떤 커밋 안의 파일 diff
 *  - `file`     파일 내용 (읽기 전용)
 *
 * 데이터(diff/내용)는 탭에 담아 둔다. 탭을 오갈 때 다시 받지 않으려는 것이다.
 * 워킹트리가 바뀌면 `markStale()`로 표시만 해 두고, 그 탭을 실제로 볼 때 다시 받는다.
 */

const MAX_TABS = 12

/** 같은 문서를 두 번 열지 않도록 식별자를 만든다. */
export function tabId(doc) {
  if (doc.kind === 'file') return `file:${doc.path}`
  if (doc.kind === 'commit') return `commit:${doc.sha}:${doc.path}`
  return `work:${doc.staged ? 'staged' : 'unstaged'}:${doc.path}`
}

export function useTabs() {
  const tabs = ref([])
  const activeId = ref(null)
  let clock = 0 // 마지막으로 본 순서. 탭이 넘칠 때 무엇을 버릴지 정한다.

  const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null)

  /** 이미 열려 있으면 그 탭으로 가고, 없으면 새로 만든다. */
  function open(doc) {
    const id = tabId(doc)
    const found = tabs.value.find((t) => t.id === id)
    if (found) {
      // 줄 이동 같은 요청은 갱신해 준다 (⌘⇧F 결과에서 다시 열 때)
      if (doc.line) found.line = doc.line
      found.seenAt = ++clock
      activeId.value = id
      return found
    }

    const tab = { ...doc, id, data: null, stale: false, error: '', seenAt: ++clock }
    tabs.value.push(tab)
    activeId.value = id
    evict()
    return tab
  }

  /** 탭이 너무 많으면 가장 오래 안 본 것을 닫는다. 현재 탭은 건드리지 않는다. */
  function evict() {
    while (tabs.value.length > MAX_TABS) {
      const victim = tabs.value
        .filter((t) => t.id !== activeId.value)
        .sort((a, b) => a.seenAt - b.seenAt)[0]
      if (!victim) return
      close(victim.id)
    }
  }

  function close(id) {
    const at = tabs.value.findIndex((t) => t.id === id)
    if (at === -1) return
    tabs.value.splice(at, 1)
    if (activeId.value !== id) return
    // 닫은 자리의 이웃으로 옮긴다. 오른쪽이 있으면 오른쪽, 없으면 왼쪽.
    const next = tabs.value[at] ?? tabs.value[at - 1] ?? null
    activeId.value = next?.id ?? null
    if (next) next.seenAt = ++clock
  }

  function closeAll() {
    tabs.value = []
    activeId.value = null
  }

  function activate(id) {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab) return
    tab.seenAt = ++clock
    activeId.value = id
  }

  function step(delta) {
    if (tabs.value.length < 2) return
    const at = tabs.value.findIndex((t) => t.id === activeId.value)
    const next = tabs.value[(at + delta + tabs.value.length) % tabs.value.length]
    activate(next.id)
  }

  /**
   * 워킹트리가 바뀌었을 때. 워킹트리 탭만 다시 받아야 한다 —
   * 커밋과 파일 히스토리는 이미 확정된 내용이라 바뀌지 않는다.
   */
  function markStale() {
    for (const tab of tabs.value) {
      if (tab.kind === 'worktree') tab.stale = true
    }
  }

  /** 목록에서 사라진 워킹트리 탭을 닫는다 (커밋했거나 되돌린 경우). */
  function pruneWorktree(livePaths) {
    for (const tab of [...tabs.value]) {
      if (tab.kind !== 'worktree') continue
      if (!livePaths.has(`${tab.staged ? 'staged' : 'unstaged'}:${tab.path}`)) close(tab.id)
    }
  }

  return { tabs, activeId, active, open, close, closeAll, activate, step, markStale, pruneWorktree }
}

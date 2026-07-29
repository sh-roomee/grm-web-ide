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
 *
 * **미리 보기 탭(`preview: true`)이 하나까지 있다.** 목록에서 훑어볼 때마다 탭이
 * 쌓이면 12개가 금방 차고, 정작 붙잡아 두려던 것이 밀려 나간다. 그래서 한 번 누르면
 * 그 자리를 *대신하고*(replace), 두 번 누르면 *붙잡는다*(pin). VS Code와 같은 규칙이다.
 */

const MAX_TABS = 12

/** 닫은 탭을 되살릴 수 있게 남겨 두는 개수 (⌥⇧T) */
const CLOSED_MAX = 10

/** 같은 문서를 두 번 열지 않도록 식별자를 만든다. */
export function tabId(doc) {
  if (doc.kind === 'file') return `file:${doc.path}`
  if (doc.kind === 'commit') return `commit:${doc.sha}:${doc.path}`
  if (doc.kind === 'compare') return `compare:${doc.base}:${doc.path}`
  return `work:${doc.staged ? 'staged' : 'unstaged'}:${doc.path}`
}

export function useTabs() {
  const tabs = ref([])
  const activeId = ref(null)
  const closed = ref([]) // 되살릴 수 있는 것들. 마지막에 닫은 것이 뒤에 온다
  let clock = 0 // 마지막으로 본 순서. 탭이 넘칠 때 무엇을 버릴지 정한다.

  const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null)
  const canReopen = computed(() => closed.value.length > 0)

  /**
   * 이미 열려 있으면 그 탭으로 가고, 없으면 새로 만든다.
   *
   * @param opts.pin `true`면 붙잡아 둔다(두 번 누름). `false`면 미리 보기 —
   *   이미 있는 미리 보기 탭의 자리를 대신하고, 그래서 훑어봐도 탭이 쌓이지 않는다.
   */
  function open(doc, { pin = false } = {}) {
    const id = tabId(doc)
    const found = tabs.value.find((t) => t.id === id)
    if (found) {
      // 줄 이동 같은 요청은 갱신해 준다 (⌘⇧F 결과에서 다시 열 때)
      if (doc.line) found.line = doc.line
      // 앵커도 갱신한다. 이미 열어 둔 문서의 다른 절을 가리키는 링크를 눌렀을 때다.
      if (doc.hash) found.hash = doc.hash
      // 미리 보기로 보던 것을 두 번 누르면 그 자리에서 붙잡는다
      if (pin) found.preview = false
      found.seenAt = ++clock
      activeId.value = id
      return found
    }

    const tab = { ...doc, id, data: null, stale: false, error: '', seenAt: ++clock, preview: !pin }

    // 미리 보기끼리는 자리를 물려받는다. 붙잡은 탭은 밀어내지 않는다.
    const at = pin ? -1 : tabs.value.findIndex((t) => t.preview)
    if (at === -1) tabs.value.push(tab)
    else tabs.value.splice(at, 1, tab)

    activeId.value = id
    evict()
    return tab
  }

  /** 미리 보기를 붙잡는다. 두 번 누르기와 탭 두 번 누르기가 둘 다 여기로 온다. */
  function pin(id) {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab) tab.preview = false
  }

  /** 탭이 너무 많으면 가장 오래 안 본 것을 닫는다. 현재 탭은 건드리지 않는다. */
  function evict() {
    while (tabs.value.length > MAX_TABS) {
      const victim = tabs.value
        .filter((t) => t.id !== activeId.value)
        .sort((a, b) => a.seenAt - b.seenAt)[0]
      if (!victim) return
      // 자동으로 밀려난 것은 되살림 목록에 넣지 않는다. 사람이 닫은 것이 아니다.
      close(victim.id, { remember: false })
    }
  }

  /**
   * 되살릴 수 있게 남긴다.
   *
   * 데이터(diff 내용)는 버리고 무엇을 보고 있었는지만 남긴다 — 되살릴 때 다시 받으면
   * 되고, 그 사이에 워킹트리가 바뀌었을 수도 있다. 자리(`at`)도 기억해 둔다: 닫은 것을
   * 다시 열면 있던 자리에 있길 기대한다.
   */
  function remember(tab, at) {
    const { data, stale, error, seenAt, id, preview, ...doc } = tab
    closed.value.push({ doc, at })
    if (closed.value.length > CLOSED_MAX) closed.value.shift()
  }

  function close(id, { remember: keep = true } = {}) {
    const at = tabs.value.findIndex((t) => t.id === id)
    if (at === -1) return
    const [gone] = tabs.value.splice(at, 1)
    // 미리 보기는 남기지 않는다. 붙잡지 않은 것을 되살리면 목록이 금방 지저분해진다.
    if (keep && gone && !gone.preview) remember(gone, at)
    if (activeId.value !== id) return
    // 닫은 자리의 이웃으로 옮긴다. 오른쪽이 있으면 오른쪽, 없으면 왼쪽.
    const next = tabs.value[at] ?? tabs.value[at - 1] ?? null
    activeId.value = next?.id ?? null
    if (next) next.seenAt = ++clock
  }

  /**
   * 마지막에 닫은 탭을 되살린다 (⌥⇧T).
   *
   * 되살린 것은 붙잡은 상태로 둔다 — 일부러 다시 열었으니 또 밀려나면 안 된다.
   */
  function reopen() {
    const last = closed.value.pop()
    if (!last) return null

    const id = tabId(last.doc)
    const exists = tabs.value.find((t) => t.id === id)
    if (exists) {
      exists.preview = false
      activate(id)
      return exists
    }

    const tab = {
      ...last.doc,
      id,
      data: null,
      stale: false,
      error: '',
      seenAt: ++clock,
      preview: false,
    }
    tabs.value.splice(Math.min(last.at, tabs.value.length), 0, tab)
    activeId.value = id
    evict()
    return tab
  }

  function closeAll() {
    // 모두 닫아도 ⌥⇧T로 하나씩 되살릴 수 있게 남긴다 (미리 보기는 빼고)
    tabs.value.forEach((tab, at) => {
      if (!tab.preview) remember(tab, at)
    })
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
      // 커밋했거나 되돌려서 사라진 것이다. 되살릴 대상이 아니다 — 그 변경은 이제 없다.
      if (!livePaths.has(`${tab.staged ? 'staged' : 'unstaged'}:${tab.path}`)) {
        close(tab.id, { remember: false })
      }
    }
  }

  return {
    tabs,
    activeId,
    active,
    canReopen,
    open,
    pin,
    close,
    closeAll,
    reopen,
    activate,
    step,
    markStale,
    pruneWorktree,
  }
}

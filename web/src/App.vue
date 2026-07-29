<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import ChangeList from './components/ChangeList.vue'
import CommitList from './components/CommitList.vue'
import BranchSelect from './components/BranchSelect.vue'
import ContextMenu from './components/ContextMenu.vue'
import FileTree from './components/FileTree.vue'
import RefPicker from './components/RefPicker.vue'
import DiffViewer from './components/DiffViewer.vue'
import SearchEverywhere from './components/SearchEverywhere.vue'
import ReviewSheet from './components/ReviewSheet.vue'
import ContextSheet from './components/ContextSheet.vue'
import SummarySheet from './components/SummarySheet.vue'
import TabBar from './components/TabBar.vue'
import { useReview } from './composables/useReview.js'
import { useHistory } from './composables/useHistory.js'
import { useTabs, tabId } from './composables/useTabs.js'
import { useComments } from './composables/useComments.js'
import { useContext } from './composables/useContext.js'
import { useCodeFont } from './composables/useCodeFont.js'
import { copyToClipboard } from './lib/clipboard.js'
import * as api from './api.js'

const repo = ref(null)
const status = ref({ staged: [], unstaged: [], conflicted: [] })
const selected = ref(null)
const diffLoading = ref(false)

// --- 기준점: "내가 마지막으로 확인한 시점" 이후 바뀐 것만 보기
const baseline = ref(null) // { tree, freshCount }
const freshOnly = ref(false) // 좌측 목록을 새 변경만으로 좁힌다
/**
 * diff의 이전 쪽을 무엇으로 볼지: 'head' | 'baseline' | 'seen'
 *
 * 'seen'(확인 이후)은 파일마다 스냅샷이 있는지가 다르다. 그래서 이 값은 "고른 것"이고,
 * 실제로 걸 수 있는지는 파일별로 판단한다(`compareFor`).
 */
const compare = ref('head')

// --- 위험 신호: AI가 조용히 지운 것들
const risks = ref({ files: {}, total: 0, fileCount: 0 })
const riskOnly = ref(false) // 좌측 목록을 위험 신호가 있는 파일로 좁힌다
const diffError = ref('')
const fatal = ref('')
const context = ref(3)
const live = ref(false)
const lastSync = ref('')
const connected = ref(true)
const retrying = ref(false)

const repoRoot = computed(() => repo.value?.root ?? null)
// 확인을 누르면 서버가 그때의 내용도 스냅샷으로 굳힌다. 그 사실(`seen` 플래그)을
// 알아야 '확인 이후' 선택지를 내놓을 수 있어서, 저장이 끝나면 상태를 다시 받는다.
const review = useReview(repoRoot, { onSaved: () => loadStatus() })

// --- 탭: 워킹트리 변경 / 커밋 히스토리
const VIEWS = [
  { key: 'changes', label: '변경사항' },
  { key: 'history', label: '히스토리' },
]
const view = ref('changes')
const history = useHistory()
const commitFile = ref(null) // 히스토리 화면에서 고른 파일
const diffViewer = ref(null) // ⌘F를 넘겨주기 위한 참조
const tabs = useTabs()
const comments = useComments()
const basket = useContext()
const codeFont = useCodeFont()
const copied = ref(false)

// 글자 크기를 바꾼 직후에만 지금 크기를 알려 준다
const fontBadge = ref(false)
let fontBadgeTimer = 0
watch(codeFont.size, () => {
  fontBadge.value = true
  clearTimeout(fontBadgeTimer)
  fontBadgeTimer = setTimeout(() => (fontBadge.value = false), 1100)
})
const contextOpen = ref(false)
const summaryOpen = ref(false)
const summaryText = ref('')
const summaryLoading = ref(false)
const reviewOpen = ref(false)
// 리뷰 시트에서 고른 코멘트와, 그것으로 미리 만들어 둔 프롬프트
const pickedIds = ref([])
const pickedPrompt = ref('')

/** 지금 보고 있는 파일의 줄별 코멘트. DiffViewer가 줄마다 물어본다. */
function commentsForActive(side, line) {
  const tab = tabs.active.value
  if (!tab) return null
  return comments.forLine(tab.path, side, line)
}

async function addComment(draft) {
  const tab = tabs.active.value
  if (!tab) return
  await comments.add({
    ...draft,
    path: tab.path,
    sha: tab.kind === 'commit' ? tab.sha : null,
  })
}

async function copyPrompt(ids = null) {
  const ok = await comments.copyPrompt(ids)
  copied.value = ok
  if (ok) setTimeout(() => (copied.value = false), 1600)
}

/**
 * 사이클 요약을 받아 보여준다.
 *
 * 열 때 받는다 — 열어 둔 채로 파일이 바뀌면 낡지만, 요약은 "지금 이 순간"을
 * 넘기려고 여는 것이라 열 때가 곧 그 순간이다. 문장을 미리 들고 있어야
 * 복사 버튼이 클릭 제스처를 잃지 않는다.
 */
async function openSummary() {
  summaryOpen.value = true
  summaryLoading.value = true
  try {
    summaryText.value = (await api.fetchSummary()).summary
  } catch (err) {
    summaryText.value = `요약을 만들지 못했습니다: ${err.message}`
  } finally {
    summaryLoading.value = false
  }
}

async function copySummary() {
  const ok = await copyToClipboard(summaryText.value)
  copied.value = ok
  if (ok) setTimeout(() => (copied.value = false), 1600)
  summaryOpen.value = false
}

/** 컨텍스트에 담는다. 어디서 담든 여기로 온다. */
function stash(item) {
  basket.add(item)
}

async function copyContext() {
  const ok = await basket.copyPrompt()
  copied.value = ok
  if (ok) setTimeout(() => (copied.value = false), 1600)
  contextOpen.value = false
}

function openFromContext({ path, line = null }) {
  contextOpen.value = false
  openFile({ path, line })
}

/**
 * 고른 코멘트로 만든 프롬프트를 **미리** 받아 둔다.
 *
 * 복사할 때 받아 오면 늦다 — `await` 하나만 지나도 브라우저가 클릭 제스처를
 * 끝난 것으로 보고 클립보드 권한을 회수한다.
 */
watch([pickedIds, () => comments.comments.value], async ([ids]) => {
  if (!ids.length) {
    pickedPrompt.value = ''
    return
  }
  try {
    pickedPrompt.value = (await api.fetchComments(ids)).prompt
  } catch {
    pickedPrompt.value = ''
  }
})

/**
 * 고른 코멘트를 프롬프트로 넘기고 시트를 닫는다.
 *
 * 복사가 이 화면의 목적이라, 담고 나면 사람은 터미널로 간다. 시트를 열어 두면
 * 성공 표시(헤더의 ✓ 복사됨)를 가린다.
 */
async function sendPrompt() {
  await copyPrompt(pickedPrompt.value)
  reviewOpen.value = false
}

/**
 * 리뷰 스레드에서 파일을 열면 시트를 닫는다.
 *
 * 열어 놓은 채로 두면 방금 연 그 줄을 시트가 가린다 — 보러 가는 동작인데
 * 목적지가 안 보이면 소용이 없다.
 */
function openFromReview({ path, line = null }) {
  reviewOpen.value = false
  openFile({ path, line })
}

// 히스토리 탭을 처음 열 때만 로그와 브랜치 목록을 받는다
watch(view, async (next) => {
  if (next === 'history' && !history.commits.value.length) await history.init()
})

// 커밋을 바꾸면 그 커밋의 첫 파일을 자동으로 보여준다
watch(
  () => history.detail.value,
  (detail) => {
    commitFile.value = detail?.files?.[0] ?? null
  },
)

const commitGroups = computed(() => [
  { key: 'commit', title: '', files: history.detail.value?.files ?? [] },
])

/**
 * 브랜치 비교 (base...HEAD, merge-base 기준).
 *
 * "이 브랜치가 결국 무엇을 바꿨나" — PR 올리기 전 마지막 확인 자리다. 변경사항
 * 화면과 같은 레이아웃을 쓰고, 코멘트도 그대로 단다(코드가 워킹트리에 있으므로
 * 반영 판정까지 워킹트리 코멘트처럼 동작한다).
 */
const compareInfo = ref(null) // { base, mergeBase, head, ahead, behind, files }
const compareFile = ref(null)
const compareRefs = ref([]) // 기준 선택기(RefPicker)에 줄 목록
const compareFilter = ref('') // 파일 이름 거르기 — 브랜치 하나가 파일 천 개를 바꾸기도 한다
const compareFilterEl = ref(null)

async function startCompare(base = compareInfo.value?.base ?? null) {
  try {
    const info = await api.fetchCompare(base)
    compareInfo.value = info
    compareFilter.value = ''
    view.value = 'compare'
    compareFile.value = info.files[0] ?? null
  } catch (err) {
    showToast(err.message, { ttl: 6000 })
    return
  }
  if (!compareRefs.value.length) {
    try {
      compareRefs.value = (await api.fetchRefs()).refs
    } catch {
      // 선택기 목록만 비는 것 — 비교 자체는 이미 떠 있다
    }
  }
}

function closeCompare() {
  compareInfo.value = null
  compareFile.value = null
  view.value = 'changes'
}

/**
 * 우클릭 → Git → 브랜치 비교: 브랜치를 **먼저 고른다** (IntelliJ의
 * Compare with Branch). 파일을 보다가 들어온 것이므로, 고르면 비교 화면으로
 * 가면서 **그 파일**이 열린다. 그 파일에 차이가 없으면 없다고 알린다.
 */
const branchSelect = ref(null) // { path } | null — 열려 있으면 선택 팝업
function askCompareBranch(path = null) {
  branchSelect.value = { path }
  if (!compareRefs.value.length) {
    api
      .fetchRefs()
      .then((r) => (compareRefs.value = r.refs))
      .catch(() => {}) // 목록만 빈다 — 팝업에서 "없습니다"로 보인다
  }
}

async function pickCompareBranch(base) {
  const path = branchSelect.value?.path ?? null
  branchSelect.value = null
  await startCompare(base)
  if (!path || !compareInfo.value) return
  const file = compareInfo.value.files.find((f) => f.path === path)
  if (file) compareFile.value = file
  else showToast(`차이 없음 — ${path} · ${base} 기준으로 내용이 같다`, { ttl: 5000 })
}

/**
 * 우클릭 컨텍스트 메뉴 — IDE의 편집기 메뉴 자리.
 *
 * git 기능은 `Git ▸` 하위로 묶는다. 지금은 셋(비교·fetch·pull)이지만
 * blame·파일 히스토리가 들어올 자리가 이곳이다 — 기능이 늘 때마다 화면
 * 어딘가에 버튼을 더 박지 않아도 된다.
 */
const ctxMenu = ref(null) // { x, y, sections }
let ctxFile = null // 메뉴가 가리키는 파일 { path, staged? } | null

/**
 * Blame 주석 (IntelliJ의 Annotate). 줄 왼쪽에 날짜·작성자가 붙고, 올리면 커밋
 * 정보, 누르면 그 커밋으로 간다.
 *
 * blame은 **지금 워킹트리 파일** 기준이다. 커밋·비교 탭의 오른쪽은 다른 시점의
 * 내용이라 줄 번호가 어긋날 수 있어 켜지 못하게 한다.
 */
const blameOn = ref(false)
const blameData = ref(null) // { path, lines, commits }

const blameEligible = computed(() => {
  const kind = tabs.active.value?.kind
  return kind === 'file' || kind === 'worktree'
})

async function loadBlame() {
  const tab = tabs.active.value
  if (!blameOn.value || !tab || !blameEligible.value) return
  if (blameData.value?.path === tab.path) return
  try {
    blameData.value = { path: tab.path, ...(await api.fetchBlame(tab.path)) }
  } catch (err) {
    blameOn.value = false
    showToast(`blame 실패 — ${err.message}`, { ttl: 5000 })
  }
}

function toggleBlame() {
  blameOn.value = !blameOn.value
  if (blameOn.value) loadBlame()
}

// 탭을 옮기면 그 파일의 blame을 받는다 (켜져 있을 때만)
watch(() => tabs.activeId.value, loadBlame)

/** 지금 탭에 보여줄 blame. 켜져 있고, 그 파일 것일 때만. */
const activeBlame = computed(() => {
  if (!blameOn.value || !blameEligible.value) return null
  const tab = tabs.active.value
  return blameData.value?.path === tab?.path ? blameData.value : null
})

/**
 * 액션 레지스트리 — 화면 기능을 이름으로 실행한다.
 *
 * 통합 검색(Shift 두 번)의 '액션' 결과와 우클릭 `Git ▸` 메뉴가 **같은 목록**을
 * 쓴다. 이름과 동작이 두 곳에 흩어져 있으면 하나만 고치고 다른 하나가 남는다.
 *
 * `when`이 false면 지금 상태에서 뜻이 없는 것이라 목록에서 빠진다 — 예를 들어
 * 담은 것이 없는데 '컨텍스트 바구니'를 실행할 수는 없다. 이렇게 하면 검색 결과가
 * "지금 할 수 있는 것"만 보여 준다.
 */
const ACTIONS = computed(() => [
  {
    key: 'git:compare',
    group: 'git',
    label: '브랜치 비교…',
    desc: '다른 브랜치와 merge-base 기준으로 비교',
    words: ['compare', 'branch', '브랜치', '비교'],
  },
  {
    key: 'git:blame',
    group: 'git',
    label: blameOn.value ? 'Blame 주석 끄기' : 'Blame 주석',
    desc: blameEligible.value ? '줄마다 누가 언제 바꿨나' : '워킹트리 파일에서만',
    words: ['blame', 'annotate', '블레임', '주석', '어노테이트'],
    when: blameEligible.value || blameOn.value,
  },
  {
    key: 'git:fetch',
    group: 'git',
    label: 'git fetch',
    desc: '원격의 새 커밋을 가져온다',
    words: ['fetch', 'git fetch', '페치', '가져오기'],
  },
  {
    key: 'git:pull',
    group: 'git',
    label: 'git pull',
    desc: 'fast-forward만 — 갈라져 있으면 터미널로',
    words: ['pull', 'git pull', '풀', '당겨오기', '받아오기'],
  },
  {
    key: 'review:all',
    label: '전체 확인',
    desc: '모두 확인 처리하고 기준점을 새로 잡는다',
    words: ['확인', '전체 확인', 'review', 'baseline', '기준점'],
    when: progress.value.total > 0,
  },
  {
    key: 'baseline:drop',
    label: '기준점 해제',
    desc: '기준점을 지운다 (HEAD 대비로 돌아간다)',
    words: ['기준점', 'baseline', '해제', 'drop'],
    when: Boolean(baseline.value),
  },
  {
    key: 'summary',
    label: '사이클 요약',
    desc: '기준점 이후 무엇이 바뀌고 무엇이 남았나',
    words: ['요약', 'summary', '사이클', 'cycle'],
    when: progress.value.total > 0,
  },
  {
    key: 'review:sheet',
    label: '리뷰 스레드',
    desc: '코멘트를 모아 보고 골라 프롬프트로 넘긴다',
    words: ['리뷰', 'review', '코멘트', 'comment', '프롬프트', 'prompt'],
    when: comments.comments.value.length > 0,
  },
  {
    key: 'context:sheet',
    label: '컨텍스트 바구니',
    desc: '담아 둔 파일·구간·검색을 프롬프트로 넘긴다',
    words: ['컨텍스트', 'context', '바구니', '담기'],
    when: basket.count.value > 0,
  },
  {
    key: 'view:toggle',
    label: view.value === 'changes' ? '히스토리 보기' : '변경사항 보기',
    desc: 'Tab 키로도 전환한다',
    words: ['히스토리', 'history', '변경사항', 'changes', '전환'],
  },
  {
    key: 'tree:toggle',
    label: treeOpen.value ? '파일 트리 접기' : '파일 트리 펼치기',
    desc: '사이드바의 디렉토리 트리',
    words: ['트리', 'tree', '파일', '사이드바'],
  },
  {
    key: 'font:reset',
    label: '코드 글자 크기 기본값',
    desc: '⌘0 과 같다',
    words: ['글자', 'font', '크기', 'size', '기본값', 'reset'],
    when: !codeFont.isDefault.value,
  },
])

const availableActions = computed(() => ACTIONS.value.filter((a) => a.when !== false))

function gitMenuItems() {
  return {
    key: 'git',
    label: 'Git',
    children: ACTIONS.value
      .filter((a) => a.group === 'git')
      .map((a) => ({
        key: a.key,
        label: a.label,
        hint: a.key === 'git:pull' ? 'ff-only' : '',
        disabled: a.when === false,
      })),
  }
}

/**
 * 액션 하나를 실행한다. 팔레트와 우클릭 메뉴가 함께 쓴다.
 * `path`는 그 액션이 가리키는 파일 — 우클릭은 누른 파일, 팔레트는 보고 있는 탭이다.
 */
function runActionKey(key, path = null) {
  if (key === 'git:compare') askCompareBranch(path)
  else if (key === 'git:blame') toggleBlame()
  else if (key === 'git:fetch') runAction('fetch')
  else if (key === 'git:pull') runAction('pull')
  else if (key === 'review:all') markReviewed()
  else if (key === 'baseline:drop') dropBaseline()
  else if (key === 'summary') openSummary()
  else if (key === 'review:sheet') reviewOpen.value = true
  else if (key === 'context:sheet') contextOpen.value = true
  else if (key === 'view:toggle') view.value = view.value === 'changes' ? 'history' : 'changes'
  else if (key === 'tree:toggle') treeOpen.value = !treeOpen.value
  else if (key === 'font:reset') codeFont.reset()
}

function openFileMenu(event, file = null, { stageable = false } = {}) {
  ctxFile = file
  const sections = []
  if (file) {
    const items = [
      { key: 'open', label: '탭으로 열기' },
      { key: 'stash', label: '컨텍스트에 담기' },
      { key: 'copy-path', label: '경로 복사' },
    ]
    if (stageable) {
      items.splice(2, 0, {
        key: file.staged ? 'unstage' : 'stage',
        label: file.staged ? 'unstage' : 'stage',
      })
    }
    sections.push({ items })
  }
  sections.push({ items: [gitMenuItems()] })
  ctxMenu.value = { x: event.clientX, y: event.clientY, sections }
}

/** 코드 영역 우클릭. 입력창은 브라우저 기본 메뉴가 맞다 — 붙여넣기가 필요하다. */
function onMainContext(event) {
  if (event.target.closest('input, textarea')) return
  event.preventDefault()
  const tab = tabs.active.value
  openFileMenu(event, tab ? { path: tab.path, staged: tab.staged ?? null } : null)
}

async function onMenuPick(key) {
  const file = ctxFile
  if (key === 'open' && file) openFile({ path: file.path })
  else if (key === 'stash' && file) stash({ kind: 'file', path: file.path })
  else if (key === 'copy-path' && file) {
    if (await copyToClipboard(file.path)) showToast(`경로 복사됨 — ${file.path}`, { ttl: 2500 })
  } else if (key === 'stage' && file) act(api.stageFile, file)
  else if (key === 'unstage' && file) act(api.unstageFile, file)
  else runActionKey(key, file?.path ?? null) // Git ▸ 하위 — 팔레트와 같은 목록을 쓴다
}

const compareGroups = computed(() => {
  const files = compareInfo.value?.files ?? []
  const q = compareFilter.value.trim().toLowerCase()
  return [
    { key: 'compare', title: '', files: q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files },
  ]
})

/** 비교에서 파일을 고르면 비교 탭이 열린다 (커밋 화면과 같은 규칙). */
watch(compareFile, (file) => {
  if (!file || !compareInfo.value) return
  tabs.open({
    kind: 'compare',
    path: file.path,
    base: compareInfo.value.base,
    sub: `↔ ${compareInfo.value.base}`,
  })
})

function pinCompareFile(file) {
  if (!compareInfo.value) return
  tabs.pin(tabId({ kind: 'compare', path: file.path, base: compareInfo.value.base }))
}

// --- 통합 검색 (Shift 두 번 / ⌘P / ⌘⇧F / ⌘E)
const paletteOpen = ref(false)
const paletteTab = ref('all')
const paletteSeed = ref('') // 열 때 미리 채울 검색어 (드래그 선택)
const paletteClear = ref(false) // 열 때 검색어를 비운다 (⌘E — 최근 목록을 보려고)
const fileList = ref([])

/**
 * 최근에 본 파일. 검색어가 비었을 때 팔레트가 이 순서로 보여 준다(⌘E).
 *
 * 지금까지 빈 검색어에는 `git ls-files` 순서대로 앞 60개가 나왔는데, 그건 아무
 * 뜻이 없는 목록이라 사실상 "검색어를 치기 전 빈 화면"이었다. 방금 보던 파일들이
 * 거기 있으면 오가는 일이 검색 없이 끝난다.
 *
 * 탭을 옮길 때 기록한다 — 실제로 **본** 것만 남기려는 것이다(열기만 하고 지나간
 * 것과 구분되지 않지만, 탭을 여는 것이 곧 보는 것이다).
 */
const recentPaths = ref([])
watch(
  () => tabs.active.value?.path,
  (path) => {
    if (!path) return
    recentPaths.value = [path, ...recentPaths.value.filter((p) => p !== path)].slice(0, 30)
  },
)

async function loadFiles() {
  try {
    fileList.value = (await api.fetchFiles()).files
  } catch (err) {
    diffError.value = err.message
  }
}

async function openPalette(tab = 'all', seed = '', { clear = false } = {}) {
  paletteTab.value = tab
  paletteSeed.value = seed
  paletteClear.value = clear
  paletteOpen.value = true
  if (!fileList.value.length) await loadFiles()
}

// --- 디렉토리 트리 (사이드바). 펼침 여부만 기억하고, 처음에는 펼쳐져 있다
const TREE_KEY = 'grmide:tree-open'
const treeOpen = ref(localStorage.getItem(TREE_KEY) !== '0')
watch(treeOpen, (open) => {
  localStorage.setItem(TREE_KEY, open ? '1' : '0')
  if (open && !fileList.value.length) loadFiles()
})

/**
 * 액션 (통합 검색에서 이름으로 실행). 원격 조작은 fetch와 fast-forward pull이
 * 전부다 — push·rebase·reset은 넣지 않는다.
 *
 * 진행과 결과는 우측 하단 토스트로 알린다(IntelliJ의 백그라운드 작업 자리).
 * 원격 작업은 몇 초씩 걸릴 수 있어서, 돌고 있다는 표시가 없으면 눌린 건지
 * 알 수 없어 다시 누르게 된다.
 */
const toast = ref(null) // { text, busy }
let toastTimer = null
function showToast(text, { busy = false, ttl = 5000 } = {}) {
  toast.value = { text, busy }
  if (toastTimer) clearTimeout(toastTimer)
  if (!busy) toastTimer = setTimeout(() => (toast.value = null), ttl)
}

let actionBusy = false
async function runAction(key) {
  if (actionBusy) return // 원격 작업이 도는 중에 또 실행하지 않는다
  actionBusy = true
  showToast(key === 'fetch' ? 'git fetch 실행 중…' : 'git pull 실행 중…', { busy: true })
  try {
    if (key === 'fetch') {
      const { counts } = await api.gitFetch()
      if (!counts) showToast('fetch 완료')
      else if (counts.behind === 0) showToast('fetch 완료 — 원격에 새 커밋 없음')
      else showToast(`fetch 완료 — 원격에 새 커밋 ${counts.behind}개 (pull로 가져온다)`)
    } else if (key === 'pull') {
      const { output } = await api.gitPull()
      showToast(output.includes('Already up to date') ? '이미 최신입니다' : 'pull 완료 (fast-forward)')
      // HEAD가 움직였다 — 상단 커밋 표시와 목록·탭을 함께 되살린다
      tabs.markStale()
      repo.value = await api.fetchRepo()
      await Promise.all([loadStatus(), loadRisks()])
      await loadActive()
    }
    // 원격 refs가 움직였으므로, 히스토리를 이미 봤다면 새로 그린다
    if (history.commits.value.length) {
      history.loadRefs()
      history.loadLog()
    }
  } catch (err) {
    showToast(
      err.message.includes('fast-forward')
        ? 'fast-forward 불가 — 로컬과 원격이 갈라져 있다. 머지/리베이스 판단은 터미널에서.'
        : err.message,
      { ttl: 8000 },
    )
  } finally {
    actionBusy = false
  }
}

/**
 * 트리와 변경 목록 사이 분할선. 경계 어디를 잡아도 끌린다 — CSS resize의
 * 구석 손잡이는 자리도 못 찾고 최대 높이도 고정이었다.
 */
const TREE_H_KEY = 'grmide:tree-height'
const treeHeight = ref(Number.parseInt(localStorage.getItem(TREE_H_KEY) ?? '', 10) || 260)
const changesSide = ref(null)

function startSplit(event) {
  const startY = event.clientY
  // 저장값이 아니라 실제 그려진 높이에서 시작한다 — CSS 최대치에 눌려 있을 수 있다
  const startH = changesSide.value?.firstElementChild?.offsetHeight ?? treeHeight.value
  const max = (changesSide.value?.clientHeight ?? 600) - 140 // 변경 목록의 최소 자리

  const onMove = (e) => {
    treeHeight.value = Math.min(Math.max(startH + e.clientY - startY, 80), max)
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    localStorage.setItem(TREE_H_KEY, String(treeHeight.value))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  // 끄는 동안 커서가 행 위를 지나도 모양이 흔들리지 않게
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

/**
 * 파일 내용을 DiffViewer가 이해하는 모양으로 바꾼다.
 * 한 컬럼 모드라 오른쪽만 채운다. 이러면 문법 강조·찾기(⌘F)·줄바꿈이 그대로 따라온다.
 */
function fileAsDiff(doc) {
  if (!doc) return null
  return {
    path: doc.path,
    sha: doc.sha,
    language: doc.language,
    sections: doc.sections,
    binary: doc.binary,
    // 이미지면 "바이너리 파일입니다" 대신 그림을 보여준다
    preview: doc.preview ?? null,
    truncated: doc.truncated,
    lineCount: doc.lineCount,
    changes: 0,
    hunks: [
      {
        header: '',
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: doc.lines.length,
        changes: 0,
        rows: doc.lines.map((text, i) => ({
          type: 'context',
          left: null,
          right: { num: i + 1, text, words: null },
        })),
      },
    ],
  }
}

/** ⌘P / ⌘⇧F 결과에서 파일을 열면 새 탭이 된다. */
/**
 * 파일을 문서 탭으로 연다.
 *
 * **기본이 "붙잡아 열기"다.** 미리 보기는 목록을 훑는 동작에만 쓴다 — ⌘P나 검색
 * 결과로 여는 것은 이미 무엇을 볼지 정하고 찾아온 것이라, 다음에 무엇을 누르면
 * 사라지는 탭으로 주면 오히려 놀란다.
 *
 * 예외는 문서 안 링크(`pin: false`)다. 그쪽은 읽던 흐름을 따라가는 것이라 문서를
 * 몇 개 거치면 탭이 쌓인다.
 */
function openFile({ path, line = null, hash = null }, { pin = true } = {}) {
  // 비교 화면에서는 비교에 포함된 파일이면 **비교 탭**으로 연다 — ⌘P·검색으로
  // 찾아 열어도 지금 보던 "비교 상태"가 유지된다. 비교 밖 파일이면 여느 때처럼
  // 읽기 전용이다.
  if (view.value === 'compare' && compareInfo.value) {
    const file = compareInfo.value.files.find((f) => f.path === path)
    if (file) {
      tabs.open(
        { kind: 'compare', path, base: compareInfo.value.base, line, sub: `↔ ${compareInfo.value.base}` },
        { pin },
      )
      compareFile.value = file // 목록 선택도 따라온다
      loadActive()
      return
    }
  }
  tabs.open({ kind: 'file', path, line, hash, sub: '읽기 전용' }, { pin })
  // 이미 그 탭을 보고 있었다면 activeId가 그대로여서 watch가 돌지 않는다.
  // 그러면 줄 이동이 조용히 사라진다(⌘⇧F 결과를 연달아 누르는 경우).
  loadActive()
}

/** 검색에서 커밋을 고르면 히스토리 화면으로 옮겨 그 커밋을 띄운다. */
async function openCommit(sha) {
  view.value = 'history'
  if (!history.commits.value.length) await history.init()
  await history.selectCommit(sha)
}

/**
 * 아직 확인하지 않은 새 변경인가.
 *
 * 기준점만으로 정하면 개별 확인을 눌러도 표시가 남는다. 그래서 두 조건을 함께
 * 본다: 기준점 이후 바뀌었고(서버가 알려준다), 아직 확인 체크가 없다.
 */
function isFresh(file) {
  return Boolean(file.fresh) && !review.isReviewed(file)
}

/** 이 파일의 위험 신호. 없으면 null. */
const risksFor = (path) => risks.value.files[path] ?? null

async function loadRisks() {
  try {
    risks.value = await api.fetchRisks()
  } catch (err) {
    // 위험 신호는 부가 정보다. 실패해도 화면이 멈추지 않게 한다.
    console.error('[grmide] 위험 신호를 받지 못했습니다:', err.message)
  }
}

const groups = computed(() => {
  const keep = (files) => {
    let out = files
    if (freshOnly.value) out = out.filter(isFresh)
    if (riskOnly.value) out = out.filter((f) => risksFor(f.path))
    return out
  }
  return [
    { key: 'conflicted', title: '충돌', files: keep(status.value.conflicted) },
    { key: 'staged', title: 'Staged', files: keep(status.value.staged) },
    { key: 'unstaged', title: '수정', files: keep(status.value.unstaged) },
  ]
})

/** 필터와 무관한 전체 목록. 진행률과 탭 정리에 쓴다. */
const allFiles = computed(() => [
  ...status.value.conflicted,
  ...status.value.staged,
  ...status.value.unstaged,
])

/** 아직 확인하지 않은 새 변경 파일들. 개별 확인 후 다음으로 넘어갈 때 쓴다. */
const freshFiles = computed(() => allFiles.value.filter(isFresh))

/** 지금 보고 있는 탭에 해당하는 status 파일. 개별 확인 버튼에 필요하다. */
const activeStatusFile = computed(() => {
  const tab = tabs.active.value
  if (!tab || tab.kind !== 'worktree') return null
  return (
    allFiles.value.find((f) => f.path === tab.path && Boolean(f.staged) === Boolean(tab.staged)) ??
    null
  )
})

/** 그 파일에 확인 시점 스냅샷이 있는가. 서버가 `/api/status`에서 알려준다. */
function hasSnapshot(path) {
  return allFiles.value.some((f) => f.path === path && f.seen)
}

/**
 * 이 파일에 실제로 걸 비교 대상.
 *
 * 고른 값을 그대로 쓰지 않는다. '확인 이후'는 그 파일을 한 번이라도 확인했을 때만
 * 뜻이 있고, 스냅샷이 없는 파일에 걸면 파일 전체가 새로 추가된 것처럼 나온다.
 * 그럴 때는 조용히 HEAD 대비로 떨어뜨린다 — 빈 화면을 보여주는 것보다 낫다.
 */
function compareFor(tab) {
  if (compare.value === 'seen') return hasSnapshot(tab.path) ? 'seen' : 'head'
  if (compare.value === 'baseline') return baseline.value ? 'baseline' : 'head'
  return 'head'
}

/** 지금 파일에서 고를 수 있는 비교 대상. DiffViewer가 세그먼트를 그릴 때 쓴다. */
const compareOptions = computed(() => {
  const tab = tabs.active.value
  if (!tab || tab.kind !== 'worktree') return []
  const out = [{ key: 'head', label: 'HEAD 대비', hint: 'git이 원래 보여주는 전체 변경' }]
  if (baseline.value) {
    out.push({ key: 'baseline', label: '기준점 이후', hint: '기준점을 잡은 뒤 바뀐 것만' })
  }
  if (hasSnapshot(tab.path)) {
    out.push({
      key: 'seen',
      label: '확인 이후',
      hint: '이 파일을 확인함으로 표시한 뒤 바뀐 것만',
    })
  }
  return out.length > 1 ? out : []
})

/**
 * 이 파일 확인 — Cursor처럼 보고 있는 파일을 하나씩 넘긴다.
 * 확인하면 다음 새 변경으로 자동으로 옮겨 간다. 44개를 훑을 때 이게 전부다.
 */
function confirmActive() {
  const file = activeStatusFile.value
  if (!file || review.isReviewed(file)) return
  const next = freshFiles.value.find((f) => f !== file) ?? null
  review.toggle(file)
  if (next) selected.value = next
}

/**
 * 전체 확인 — 지금 상태를 기준점으로 굳히고 모두 확인 처리한다.
 *
 * 둘은 같은 뜻이고(다 봤다), 따로 두면 사용자가 두 번 눌러야 한다.
 * 그 뒤 AI가 고친 파일만 새 변경으로 뜨고 확인 체크도 자동으로 풀린다.
 */
async function markReviewed() {
  try {
    await api.setBaseline()
    review.markAll(allFiles.value, true)
    await loadStatus()
  } catch (err) {
    diffError.value = err.message
  }
}

async function dropBaseline() {
  try {
    await api.clearBaseline()
    freshOnly.value = false
    if (compare.value === 'baseline') compare.value = 'head'
    await loadStatus()
  } catch (err) {
    diffError.value = err.message
  }
}

const progress = computed(() => {
  const total = allFiles.value.length
  const done = allFiles.value.filter((f) => review.isReviewed(f)).length
  return { total, done }
})

async function loadStatus() {
  try {
    const next = await api.fetchStatus()
    status.value = next
    baseline.value = next.baseline
    if (!next.baseline) {
      freshOnly.value = false
      if (compare.value === 'baseline') compare.value = 'head'
    }
    review.prune(allFiles.value)
    lastSync.value = new Date().toLocaleTimeString('ko-KR', { hour12: false })

    // 목록에서 사라진 파일의 탭은 닫는다 (커밋했거나 되돌린 경우)
    tabs.pruneWorktree(
      new Set(allFiles.value.map((f) => `${f.staged ? 'staged' : 'unstaged'}:${f.path}`)),
    )

    // 선택한 파일이 사라졌으면 첫 파일로 옮긴다.
    if (selected.value) {
      const still = allFiles.value.find(
        (f) => f.path === selected.value.path && f.staged === selected.value.staged,
      )
      selected.value = still ?? allFiles.value[0] ?? null
    } else if (!tabs.tabs.value.length) {
      // 처음 열었을 때만 자동으로 첫 파일을 띄운다. 이미 탭이 있으면 건드리지 않는다.
      selected.value = allFiles.value[0] ?? null
    }
  } catch (err) {
    fatal.value = err.message
  }
}

// --- 목록에서 고른 것을 탭으로 연다

/** 좌측 변경 목록에서 파일을 고르면 워킹트리 탭이 열린다. */
watch(selected, (file) => {
  if (!file || view.value !== 'changes') return
  tabs.open({
    kind: 'worktree',
    path: file.path,
    staged: file.staged,
    untracked: file.untracked,
    sub: file.staged ? 'staged' : 'working tree',
  })
})

/** 커밋의 파일을 고르면 커밋 탭이 열린다. */
watch(commitFile, (file) => {
  const sha = history.selectedSha.value
  if (!file || !sha) return
  tabs.open({
    kind: 'commit',
    path: file.path,
    sha,
    sub: `커밋 ${history.detail.value?.shortSha ?? ''}`.trim(),
  })
})

/**
 * 두 번 누르면 붙잡는다.
 *
 * 한 번 누르는 것(`select`)이 이미 미리 보기로 열어 두었으므로, 여기서는 그 탭을
 * 붙잡기만 하면 된다 — 브라우저가 click 다음에 dblclick을 보내는 순서에 기댄다.
 * 열려 있는지 다시 찾지 않고 `tabId`로 곧장 짚는다. 목록이 그 사이에 바뀌었어도
 * 엉뚱한 탭을 붙잡지 않는다.
 */
function pinWorktree(file) {
  tabs.pin(tabId({ kind: 'worktree', path: file.path, staged: file.staged }))
}

function pinCommitFile(file) {
  const sha = history.selectedSha.value
  if (!sha) return
  tabs.pin(tabId({ kind: 'commit', path: file.path, sha }))
}

/**
 * 지금 보고 있는 탭의 내용을 받는다.
 *
 * 이미 받아 둔 것이 있고 낡지 않았으면 다시 받지 않는다 — 탭을 오가는 것이
 * 매번 요청이 되면 탭의 의미가 없다.
 */
async function loadActive() {
  const tab = tabs.active.value
  if (!tab) return

  // 이미 받아 둔 내용이 있으면 다시 받지 않는다. 다만 줄 이동은 건너뛰면 안 된다 —
  // 같은 파일을 다른 줄로 다시 열 수 있다.
  if (tab.data && !tab.stale) {
    await revealLine(tab)
    return
  }
  if (tab.loading) return // 이미 받는 중이면 요청을 겹치지 않는다

  tab.loading = true
  diffLoading.value = true
  tab.error = ''
  const id = tab.id
  try {
    const data =
      tab.kind === 'file'
        ? fileAsDiff(await api.fetchFile(tab.path))
        : await api.fetchDiff(
            { path: tab.path, staged: tab.staged, untracked: tab.untracked },
            {
              context: context.value,
              sha: tab.kind === 'commit' ? tab.sha : null,
              against: tab.kind === 'compare' ? tab.base : null,
              // 워킹트리 탭만 기준점·확인 시점 대비로 볼 수 있다
              compare: tab.kind === 'worktree' ? compareFor(tab) : 'head',
            },
          )
    // 늦게 온 응답은 그 탭에만 담는다 (그 사이 다른 탭으로 옮겼을 수 있다)
    const target = tabs.tabs.value.find((t) => t.id === id)
    if (target) {
      target.data = data
      target.stale = false
    }
  } catch (err) {
    const target = tabs.tabs.value.find((t) => t.id === id)
    if (target) target.error = err.message
  } finally {
    tab.loading = false
    diffLoading.value = false
  }

  await revealLine(tab)
}

/** ⌘⇧F 결과에서 열었으면 그 줄로 옮겨 준다. */
async function revealLine(tab) {
  if (!tab.line) return
  const line = tab.line
  tab.line = null
  await nextTick()
  diffViewer.value?.scrollToLine(line)
}

watch(() => tabs.activeId.value, loadActive)

// 보기 범위나 비교 대상을 바꾸면 diff 탭을 다시 받아야 한다
watch([context, compare], () => {
  for (const tab of tabs.tabs.value) {
    if (tab.kind !== 'file') tab.stale = true
  }
  loadActive()
})

async function act(fn, file) {
  try {
    await fn(file.path)
    tabs.markStale()
    await loadStatus()
    await loadActive()
  } catch (err) {
    diffError.value = err.message
  }
}

let stream = null

onMounted(async () => {
  if (!api.token) {
    fatal.value = '토큰이 없습니다. 터미널에서 grmide가 출력한 주소로 다시 접속하세요.'
    return
  }
  try {
    repo.value = await api.fetchRepo()
  } catch (err) {
    fatal.value = err.message
    return
  }
  await review.load() // status보다 먼저 — 진행률이 0으로 잠깐 보이지 않게
  await Promise.all([loadStatus(), loadRisks()])
  await loadActive()
  await comments.load()
  await basket.load()
  if (treeOpen.value) loadFiles()

  // 파일이 바뀌면 서버가 알려준다. 폴링이 아니라 이 스트림이 갱신의 기준이다.
  stream = api.subscribeChanges({
    onChange: async () => {
      live.value = true
      tabs.markStale()
      // 트리·팔레트가 이미 목록을 들고 있으면 같이 갱신한다 — AI가 방금 만든
      // 파일이 트리에 없으면 가장 자주 찾을 것을 못 찾는다
      const jobs = [loadStatus(), loadRisks(), comments.load(), basket.load()]
      if (fileList.value.length) jobs.push(loadFiles())
      // blame은 파일이 바뀌면 줄이 밀린다 — 비우고 지금 파일 것을 다시 받는다
      if (blameOn.value) {
        blameData.value = null
        jobs.push(loadBlame())
      }
      // 비교를 열어 뒀으면 목록도 따라온다 — AI가 커밋하면 HEAD가 움직인다
      if (compareInfo.value) {
        jobs.push(
          api
            .fetchCompare(compareInfo.value.base)
            .then((info) => (compareInfo.value = info))
            .catch(() => {}), // 기준 브랜치가 사라진 경우 등 — 다음 갱신에서 다시
        )
      }
      await Promise.all(jobs)
      await loadActive()
      setTimeout(() => (live.value = false), 600)
    },
    onConnection: (state) => {
      connected.value = state.connected
      retrying.value = state.retrying
    },
  })

  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  stream?.close()
  window.removeEventListener('keydown', onKey)
})

/** 끊긴 뒤 grmide를 다시 켰을 때. 스트림과 화면 내용을 함께 되살린다. */
async function reconnect() {
  stream?.reconnect()
  tabs.markStale()
  await loadStatus()
  await loadActive()
}

/**
 * j/k 로 파일 이동, space 로 확인 토글, Tab 으로 탭 전환.
 * 손이 터미널에 있는 사용자를 가정한다.
 */
const SHIFT_DOUBLE_TAP_MS = 400
let lastShiftAt = 0

/** 드래그로 선택한 텍스트. 여러 줄이면 검색어로 쓰기 어려워 무시한다. */
function selectedText() {
  const text = window.getSelection()?.toString().trim() ?? ''
  return text && !text.includes('\n') ? text : ''
}

function onKey(event) {
  const meta = event.metaKey || event.ctrlKey

  // Esc는 어디에 포커스가 있든 열린 것을 닫는다
  if (
    event.key === 'Escape' &&
    (paletteOpen.value ||
      reviewOpen.value ||
      contextOpen.value ||
      summaryOpen.value ||
      branchSelect.value)
  ) {
    paletteOpen.value = false
    reviewOpen.value = false
    contextOpen.value = false
    summaryOpen.value = false
    branchSelect.value = null
    return
  }

  // Shift 두 번 → 통합 검색 (IntelliJ Search Everywhere)
  if (event.key === 'Shift' && !meta && !event.altKey) {
    const now = event.timeStamp
    if (now - lastShiftAt < SHIFT_DOUBLE_TAP_MS) {
      lastShiftAt = 0
      openPalette('all')
      return
    }
    lastShiftAt = now
    return
  }
  if (event.key !== 'Shift') lastShiftAt = 0 // 사이에 다른 키가 끼면 무효

  // ⌘/Ctrl 조합은 입력창 안에서도 받는다. 브라우저 기본 동작을 대신한다.
  // 드래그로 선택해 둔 텍스트가 있으면 그것을 검색어로 미리 채운다.
  if (meta && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    const seed = selectedText()
    if (event.shiftKey) {
      openPalette('text', seed)
      return
    }
    // 비교 화면에서 목록 쪽(사이드바)에 포커스가 있으면 ⌘F는 "파일 이름 거르기"다.
    // 파일 천 개가 바뀐 브랜치에서 스크롤로 찾을 수는 없다. diff 쪽을 보고 있으면
    // 여느 때처럼 파일 안에서 찾는다.
    const inCompareList =
      view.value === 'compare' &&
      document.activeElement instanceof Element &&
      document.activeElement.closest('.compare-side')
    if (inCompareList) {
      if (seed) compareFilter.value = seed
      compareFilterEl.value?.focus()
      compareFilterEl.value?.select()
    } else diffViewer.value?.openFind(seed)
    return
  }
  if (meta && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    openPalette('file')
    return
  }
  /**
   * ⌘E — 최근 본 파일. 같은 파일 창을 열지만 **검색어를 비우고** 연다.
   *
   * ⌘P는 이전 검색어를 남긴다(같은 것을 다시 찾는 일이 잦다). 최근 목록은 그
   * 검색어가 남아 있으면 볼 수가 없으므로, 이 키만 비우고 시작한다 — 두 키의
   * 차이가 그것이다.
   */
  if (meta && event.key.toLowerCase() === 'e') {
    event.preventDefault()
    openPalette('file', '', { clear: true })
    return
  }

  /**
   * ⌘+/⌘-/⌘0 으로 코드 글자 크기. 브라우저 확대를 대신 가로챈다 — 브라우저 확대는
   * 바와 목록까지 같이 키워서 한 화면에 남는 코드가 줄어든다. 여기서는 코드 영역만
   * 움직인다.
   *
   * ⌘+는 shift 없이 누르면 '=', 누르면 '+'로 온다. 숫자패드는 'Add'/'Subtract'다.
   */
  if (meta && !event.altKey) {
    const k = event.key
    if (k === '=' || k === '+' || k === 'Add') {
      event.preventDefault()
      codeFont.grow()
      return
    }
    if (k === '-' || k === '_' || k === 'Subtract') {
      event.preventDefault()
      codeFont.shrink()
      return
    }
    if (k === '0') {
      event.preventDefault()
      codeFont.reset()
      return
    }
  }

  // ⌥←/→ 로 탭 이동. ⌘⇧[ ] 는 브라우저가 이미 쓴다.
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault()
    tabs.step(event.key === 'ArrowRight' ? 1 : -1)
    return
  }
  /**
   * ⌥ + 글자는 `event.code`로 본다. `event.key`로 보면 안 된다.
   *
   * macOS에서 ⌥를 누르면 OS가 글자를 바꿔 보낸다 — ⌥W는 `key: '∑'`, ⌥T는 `key: '†'`다.
   * `key.toLowerCase() === 'w'` 는 그래서 실제 키보드에서 맞지 않는다. `code`는 자리
   * 이름(`KeyW`)이라 배열·조합에 흔들리지 않는다.
   */
  if (event.altKey && !meta) {
    // ⌥W 로 현재 탭 닫기 (⌘W는 브라우저 창을 닫는다)
    if (event.code === 'KeyW' && tabs.activeId.value) {
      event.preventDefault()
      tabs.close(tabs.activeId.value)
      return
    }
    // ⌥⇧T 로 마지막에 닫은 탭 되살리기 (⌘⇧T는 브라우저가 자기 탭을 되살린다)
    if (event.code === 'KeyT' && event.shiftKey) {
      event.preventDefault()
      const back = tabs.reopen()
      if (back) loadActive()
      return
    }
  }

  // 입력창에서는 j/k 같은 단일 키를 가로채지 않는다.
  // target이 Element가 아닌 경우(합성 이벤트)도 있어 형을 확인한다.
  const target = event.target
  if (target instanceof Element && target.matches('input, select, textarea')) return

  // 읽기 전용으로 열어 둔 파일은 Esc로 닫는다. diff 탭은 Esc로 닫지 않는다 —
  // 목록에서 고른 것이므로 사용자가 닫으려는 의도로 보기 어렵다.
  if (event.key === 'Escape' && tabs.active.value?.kind === 'file') {
    tabs.close(tabs.activeId.value)
    return
  }

  if (event.key === 'Tab') {
    event.preventDefault()
    view.value = view.value === 'changes' ? 'history' : 'changes'
    return
  }

  if (event.key !== 'j' && event.key !== 'k' && event.key !== ' ') return
  const step = event.key === 'j' ? 1 : -1

  if (view.value === 'history') {
    // 히스토리에서는 커밋 사이를 오간다. 파일은 마우스로 고르는 편이 빠르다.
    if (event.key === ' ') return
    event.preventDefault()
    const list = history.commits.value
    const idx = list.findIndex((c) => c.sha === history.selectedSha.value)
    const next = list[Math.min(Math.max(idx + step, 0), list.length - 1)]
    if (next) history.selectCommit(next.sha)
    return
  }

  const files = allFiles.value
  if (!files.length) return
  const idx = files.findIndex(
    (f) => f.path === selected.value?.path && f.staged === selected.value?.staged,
  )
  if (event.key === ' ') {
    if (!selected.value) return
    event.preventDefault()
    review.toggle(selected.value)
    return
  }
  selected.value = files[Math.min(Math.max(idx + step, 0), files.length - 1)]
}
</script>

<template>
  <div v-if="fatal" class="fatal">{{ fatal }}</div>

  <div v-else class="layout">
    <header class="top">
      <strong class="repo">{{ repo?.name ?? '…' }}</strong>
      <span class="branch">⎇ {{ repo?.branch ?? '' }}</span>
      <button
        v-if="!compareInfo"
        class="compare-btn"
        title="현재 브랜치를 다른 브랜치와 비교 (merge-base 기준) — 이 브랜치가 결국 무엇을 바꿨나"
        @click="startCompare()"
      >
        ↔ 비교
      </button>

      <div class="tabs" role="tablist">
        <button
          v-for="tab in VIEWS"
          :key="tab.key"
          class="tab"
          :class="{ on: view === tab.key }"
          role="tab"
          :aria-selected="view === tab.key"
          title="Tab 키로도 전환"
          @click="view = tab.key"
        >
          {{ tab.label }}
        </button>
        <button
          v-if="compareInfo"
          class="tab"
          :class="{ on: view === 'compare' }"
          role="tab"
          :aria-selected="view === 'compare'"
          :title="`${compareInfo.base}…${repo?.branch ?? 'HEAD'} 비교`"
          @click="view = 'compare'"
        >
          ↔ {{ compareInfo.base }}
        </button>
      </div>

      <span v-if="repo?.head" class="head" :title="repo.head.sha">
        {{ repo.head.shortSha }} · {{ repo.head.subject }}
      </span>
      <span class="spacer" />

      <!-- 이번 사이클에 무슨 일이 있었나 -->
      <button
        v-if="view === 'changes' && progress.total"
        class="basket-btn"
        title="기준점 이후 무엇이 바뀌고 무엇이 남았는지 한 장으로 — 다음 지시에 붙여 넣는다"
        @click="openSummary()"
      >
        요약
      </button>

      <!-- 읽을 곳을 AI에게 넘기는 경로 -->
      <button
        v-if="basket.count.value"
        class="basket-btn"
        title="컨텍스트 — 담아 둔 파일·구간·검색을 프롬프트로 넘긴다"
        @click="contextOpen = true"
      >
        컨텍스트 {{ basket.count.value }}
      </button>
      <span v-if="basket.lastAdded.value" class="stashed">{{ basket.lastAdded.value }}</span>

      <!-- 코멘트를 AI에게 넘기는 경로. 누르면 리뷰 스레드가 열린다 -->
      <template v-if="comments.comments.value.length">
        <button
          class="copy-btn"
          :class="{ done: copied }"
          title="리뷰 스레드 — 모아 보고, 보낼 것을 골라 프롬프트로 넘긴다"
          @click="reviewOpen = true"
        >
          <template v-if="copied">✓ 복사됨</template>
          <template v-else>
            리뷰 {{ comments.comments.value.length }}
            <span v-if="comments.appliedOnes.value.length" class="done-count">
              · 반영 {{ comments.appliedOnes.value.length }}
            </span>
          </template>
        </button>
        <button class="drop-btn" title="코멘트 모두 지우기" @click="comments.clear()">✕</button>
      </template>

      <!-- 기준점: AI가 계속 고치는 동안 "새로 바뀐 것"만 가려낸다 -->
      <template v-if="view === 'changes'">
        <button
          v-if="freshFiles.length"
          class="fresh-badge"
          :class="{ on: freshOnly }"
          :title="freshOnly ? '전체 변경 보기' : '새 변경만 보기'"
          @click="freshOnly = !freshOnly"
        >
          새 변경 {{ freshFiles.length }}
        </button>
        <span v-else-if="baseline" class="fresh-none" title="기준점 이후 바뀐 것이 없다">
          새 변경 없음
        </span>

        <button
          v-if="risks.fileCount"
          class="risk-badge"
          :class="{ on: riskOnly }"
          :title="`놓치기 쉬운 지점이 ${risks.fileCount}개 파일에 ${risks.total}건. 누르면 그 파일만 본다`"
          @click="riskOnly = !riskOnly"
        >
          ⚠ {{ risks.fileCount }}
        </button>

        <button
          class="mark-btn"
          :title="
            baseline
              ? '모두 확인 처리하고 지금 상태를 새 기준점으로 잡는다'
              : '모두 확인 처리하고 지금 상태를 기준점으로 잡는다. 그 뒤 AI가 고친 파일만 새 변경으로 뜬다'
          "
          @click="markReviewed()"
        >
          전체 확인
        </button>
        <button v-if="baseline" class="drop-btn" title="기준점 해제" @click="dropBaseline()">
          ✕
        </button>

        <span class="progress">확인 {{ progress.done }}/{{ progress.total }}</span>
      </template>
      <span v-if="!connected" class="offline" title="grmide가 실행 중인지 확인하세요">
        {{ retrying ? '연결 끊김 · 다시 시도 중' : '연결 끊김 · 아래 내용은 지금 상태가 아닙니다' }}
        <button v-if="!retrying" class="relink" @click="reconnect">다시 연결</button>
      </span>
      <span v-else class="sync" :class="{ live }">{{ live ? '갱신됨' : lastSync }}</span>
    </header>

    <main class="body">
      <aside class="side">
        <!-- 변경사항 탭: 위에 디렉토리 트리(접이식), 아래 변경 목록 -->
        <div v-if="view === 'changes'" ref="changesSide" class="changes-side">
          <FileTree
            v-model:open="treeOpen"
            :files="fileList"
            :active-path="tabs.active.value?.path ?? null"
            :style="treeOpen ? { height: `${treeHeight}px` } : null"
            @select="openFile({ path: $event }, { pin: false })"
            @pin="openFile({ path: $event })"
            @menu="openFileMenu($event.event, { path: $event.path })"
          />
          <div v-if="treeOpen" class="splitter" @mousedown.prevent="startSplit" />
          <ChangeList
            :groups="groups"
            :selected="selected"
            title="변경사항"
            count-label="개"
            :is-reviewed="review.isReviewed"
            :is-fresh="isFresh"
            :risks-for="risksFor"
            @select="selected = $event"
            @pin="pinWorktree($event)"
            @toggle-review="review.toggle($event)"
            @review-all="review.markAll($event.files, true)"
            @stage="act(api.stageFile, $event)"
            @unstage="act(api.unstageFile, $event)"
            @menu="openFileMenu($event.event, $event.file, { stageable: true })"
          />
        </div>

        <!-- 브랜치 비교: 기준 선택 + 바뀐 파일 목록 -->
        <div v-else-if="view === 'compare'" class="compare-side">
          <div class="cmp-head">
            <RefPicker
              :refs="compareRefs"
              :selected="compareInfo?.base ?? null"
              align="left"
              @select="startCompare($event)"
            />
            <span class="spacer" />
            <button class="drop-btn" title="비교 닫기" @click="closeCompare()">✕</button>
          </div>
          <p class="cmp-meta" :title="`${compareInfo?.base}…${repo?.branch}`">
            {{ compareInfo?.base }}…{{ repo?.branch }} · 커밋 {{ compareInfo?.ahead ?? 0 }}개
            <template v-if="compareInfo?.behind">
              · 기준이 {{ compareInfo.behind }}개 앞서 있음
            </template>
          </p>
          <input
            ref="compareFilterEl"
            v-model="compareFilter"
            class="cmp-filter"
            type="text"
            placeholder="파일 이름으로 거르기 (⌘F)"
            @keydown.esc.prevent="((compareFilter = ''), $event.target.blur())"
          />
          <ChangeList
            class="cmp-files"
            :groups="compareGroups"
            :selected="compareFile"
            readonly
            title="바뀐 파일"
            count-label="개"
            @select="compareFile = $event"
            @pin="pinCompareFile($event)"
            @menu="openFileMenu($event.event, $event.file)"
          />
        </div>

        <!-- 히스토리 탭: 위에 커밋 목록, 아래에 그 커밋의 파일 목록 -->
        <div v-else class="history-side">
          <div class="commits">
            <CommitList
              :commits="history.commits.value"
              :lane-count="history.laneCount.value"
              :selected="history.selectedSha.value"
              :loading="history.loading.value"
              :has-more="history.hasMore.value"
              :filtered="history.filtered.value"
              :refs="history.refs.value"
              :active-ref="history.activeRef.value"
              :query="history.query.value"
              :search-in="history.searchIn.value"
              @select="history.selectCommit($event.sha)"
              @more="history.loadMore()"
              @update:active-ref="history.activeRef.value = $event"
              @update:query="history.query.value = $event"
              @update:search-in="history.searchIn.value = $event"
            />
          </div>

          <div class="commit-detail">
            <div v-if="history.detail.value" class="meta">
              <div class="meta-line">
                <span class="sha" :title="history.detail.value.sha">
                  {{ history.detail.value.shortSha }}
                </span>
                <span class="who">{{ history.detail.value.author }}</span>
                <span class="when">{{ history.detail.value.relativeDate }}</span>
              </div>
              <p class="subject">{{ history.detail.value.subject }}</p>
              <pre v-if="history.detail.value.body" class="body-text">{{
                history.detail.value.body
              }}</pre>
            </div>

            <ChangeList
              class="commit-files"
              :groups="commitGroups"
              :selected="commitFile"
              readonly
              title="바뀐 파일"
              count-label="개"
              @select="commitFile = $event"
              @pin="pinCommitFile($event)"
              @menu="openFileMenu($event.event, $event.file)"
            />
          </div>
        </div>
      </aside>

      <section class="main" @contextmenu="onMainContext">
        <TabBar
          :tabs="tabs.tabs.value"
          :active-id="tabs.activeId.value"
          @activate="tabs.activate($event)"
          @pin="tabs.pin($event)"
          @close="tabs.close($event)"
          @close-all="tabs.closeAll()"
        />

        <DiffViewer
          v-if="tabs.active.value"
          :key="tabs.active.value.id"
          ref="diffViewer"
          :single="tabs.active.value.kind === 'file'"
          :file="tabs.active.value"
          :diff="tabs.active.value.data"
          :loading="diffLoading && !tabs.active.value.data"
          :error="tabs.active.value.error || diffError"
          :badge="
            tabs.active.value.kind === 'worktree' && compare !== 'head'
              ? compareOptions.find((o) => o.key === compare)?.label
              : tabs.active.value.sub
          "
          :link="activeStatusFile?.link ?? ''"
          :compare-options="compareOptions"
          :compare="compare"
          :comments-for="commentsForActive"
          :risks="risksFor(tabs.active.value.path) ?? []"
          :blame="activeBlame"
          @open-commit="openCommit($event)"
          @update:context="context = $event"
          @update:compare="compare = $event"
          @comment="addComment($event)"
          @delete-comment="comments.remove($event)"
          @add-context="stash($event)"
          @open-file="openFile($event, { pin: false })"
        >
          <template #actions>
            <!-- Cursor처럼 보고 있는 파일을 하나씩 확인해 넘긴다 -->
            <button
              v-if="activeStatusFile && isFresh(activeStatusFile)"
              class="confirm-btn"
              title="이 파일 확인 (space) — 확인하면 다음 새 변경으로 넘어간다"
              @click="confirmActive()"
            >
              ✓ 확인
              <span v-if="freshFiles.length > 1" class="rest">
                · 남은 {{ freshFiles.length - 1 }}
              </span>
            </button>
            <span
              v-else-if="activeStatusFile && review.isReviewed(activeStatusFile)"
              class="confirmed"
              title="확인함 (space로 해제)"
            >
              ✓ 확인함
            </span>
          </template>
        </DiffViewer>

        <div v-else class="empty-main">
          <p>왼쪽에서 파일을 고르거나 <kbd>⌘P</kbd> 로 파일을 열어보세요.</p>
          <p class="dim"><kbd>Shift</kbd> <kbd>Shift</kbd> 로 파일·커밋·텍스트를 한 번에 찾습니다.</p>
        </div>
      </section>
    </main>

    <SearchEverywhere
      :open="paletteOpen"
      :tab="paletteTab"
      :seed="paletteSeed"
      :clear="paletteClear"
      :files="fileList"
      :recent="recentPaths"
      :actions="availableActions"
      @update:tab="paletteTab = $event"
      @close="paletteOpen = false"
      @open-file="openFile($event)"
      @open-commit="openCommit($event)"
      @add-context="stash($event)"
      @action="runActionKey($event, tabs.active.value?.path ?? null)"
    />

    <SummarySheet
      :open="summaryOpen"
      :text="summaryText"
      :loading="summaryLoading"
      @close="summaryOpen = false"
      @copy="copySummary()"
    />

    <ContextSheet
      :open="contextOpen"
      :items="basket.items.value"
      @close="contextOpen = false"
      @open-file="openFromContext($event)"
      @remove="basket.remove($event)"
      @clear="basket.clear()"
      @copy="copyContext()"
    />

    <ReviewSheet
      :open="reviewOpen"
      :comments="comments.comments.value"
      @close="reviewOpen = false"
      @open-file="openFromReview($event)"
      @delete="comments.remove($event)"
      @delete-many="comments.removeMany($event)"
      :picked="pickedIds"
      @update:picked="pickedIds = $event"
      @copy="sendPrompt()"
    />

    <!--
      글자 크기를 바꿨을 때만 잠깐 뜬다. ⌘+/⌘-는 눌러도 화면이 조금씩만 움직여서
      눌린 건지 브라우저가 먹은 건지 알기 어렵다. 지금 몇 px인지 말해 준다.
    -->
    <div v-if="fontBadge" class="font-badge">
      {{ codeFont.size.value }}px
      <span v-if="codeFont.isDefault.value">기본</span>
    </div>

    <ContextMenu v-if="ctxMenu" :menu="ctxMenu" @close="ctxMenu = null" @pick="onMenuPick" />

    <BranchSelect
      :open="!!branchSelect"
      :refs="compareRefs"
      @close="branchSelect = null"
      @select="pickCompareBranch($event)"
    />

    <!-- 원격 작업(fetch/pull)의 진행·결과. 실행 중에는 스피너가 돈다 -->
    <div v-if="toast" class="toast" role="status">
      <span v-if="toast.busy" class="toast-spin" />
      {{ toast.text }}
    </div>
  </div>
</template>

<style scoped>
.fatal {
  padding: 24px;
  color: var(--status-deleted);
}

.layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/**
 * 내비게이션 바 — iOS처럼 반투명하게 띄우고 아래를 머리카락 선으로 끊는다.
 * 스크롤되는 내용 위에 얹히는 층이라는 것을 흐림으로 알린다.
 */
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--bg-bar);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 0.5px solid var(--border);
  flex: none;
  min-width: 0;
  z-index: 5;
}
.repo {
  flex: none;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.branch {
  flex: none;
  color: var(--fg-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
/* 브랜치 비교 진입. 브랜치 이름 옆 — "이 브랜치가 결국 무엇을 바꿨나"로 가는 문 */
.compare-btn {
  flex: none;
  padding: 2px 9px;
  border-radius: var(--r-pill);
  color: var(--fg-dim);
  font-size: 11.5px;
  background: rgba(118, 118, 128, 0.16);
}
.compare-btn:hover {
  color: var(--fg);
  background: rgba(118, 118, 128, 0.3);
}
.head {
  color: var(--fg-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.progress {
  flex: none;
  color: var(--fg-dim);
}

/* 상태 알약. iOS 뱃지처럼 색은 옅게 깔고 글자에 색을 준다 */
.risk-badge {
  flex: none;
  padding: 2px 9px;
  background: rgba(255, 159, 10, 0.16);
  color: var(--status-conflicted);
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 590;
  font-variant-numeric: tabular-nums;
}
.risk-badge:hover {
  background: rgba(255, 159, 10, 0.26);
}
.risk-badge.on {
  background: var(--status-conflicted);
  color: #241802;
}

/* 기준점 */
.fresh-badge,
.fresh-none,
.mark-btn,
.drop-btn {
  flex: none;
  font-size: 12px;
}
.fresh-badge {
  padding: 2px 9px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: var(--r-pill);
  font-weight: 590;
  font-variant-numeric: tabular-nums;
}
.fresh-badge:hover {
  background: rgba(10, 132, 255, 0.26);
}
.fresh-badge.on {
  background: var(--accent);
  color: #fff;
}
.fresh-none {
  padding: 2px 4px;
  color: var(--fg-faint);
}
.mark-btn {
  padding: 3px 11px;
  color: var(--fg);
  background: rgba(118, 118, 128, 0.24);
  border-radius: var(--r-pill);
  font-weight: 500;
}
.mark-btn:hover {
  background: rgba(118, 118, 128, 0.36);
}
.drop-btn {
  padding: 2px 6px;
  color: var(--fg-faint);
  border-radius: var(--r-pill);
}
.drop-btn:hover {
  color: var(--fg);
  background: rgba(118, 118, 128, 0.24);
}

.basket-btn {
  flex: none;
  padding: 3px 11px;
  border-radius: var(--r-pill);
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.basket-btn:hover {
  background: rgba(118, 118, 128, 0.36);
}

/* 담긴 순간에만 잠깐 뜬다 — 시트를 열지 않아도 담긴 것을 안다 */
.stashed {
  flex: none;
  color: var(--status-added);
  font-size: 11.5px;
  animation: fade 260ms var(--ease);
}
@keyframes fade {
  from {
    opacity: 0;
  }
}

.done-count {
  opacity: 0.8;
  font-weight: 400;
}

/* 코멘트를 프롬프트로 복사 */
/* 코멘트를 AI에게 넘기는 주 동작. 화면에서 유일하게 채워진 버튼이다 */
.copy-btn {
  flex: none;
  padding: 3px 11px;
  background: var(--accent);
  color: #fff;
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 590;
  white-space: nowrap;
}
.copy-btn:hover {
  background: #3d9bff;
}
.copy-btn.done {
  background: var(--status-added);
  color: #04220d;
}

/* diff 바 안의 개별 확인 */
.confirm-btn {
  flex: none;
  padding: 3px 12px;
  background: var(--accent);
  color: #fff;
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 590;
  white-space: nowrap;
}
.confirm-btn:hover {
  background: #3d9bff;
}
.confirm-btn .rest {
  font-weight: 400;
  opacity: 0.75;
}
.confirmed {
  flex: none;
  padding: 2px 8px;
  color: var(--status-added);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
/* 원격 작업 토스트 — 우측 하단, font-badge와 같은 자리의 재료 */
.toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(420px, 60vw);
  padding: 9px 14px;
  border-radius: var(--r-md);
  background: var(--bg-sheet);
  backdrop-filter: blur(20px);
  box-shadow: var(--shadow-pop);
  color: var(--fg);
  font-size: 12.5px;
  pointer-events: none;
}
.toast-spin {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--fg-faint);
  border-top-color: var(--accent);
  animation: toast-spin 0.8s linear infinite;
}
@keyframes toast-spin {
  to {
    transform: rotate(360deg);
  }
}

.sync {
  flex: none;
  color: var(--fg-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  min-width: 62px;
  text-align: right;
}
.sync.live {
  color: var(--status-added);
}
.offline {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--status-conflicted);
}
.relink {
  padding: 2px 10px;
  border-radius: var(--r-pill);
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg);
  font-weight: 500;
}
.relink:hover {
  background: rgba(118, 118, 128, 0.36);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.side {
  width: 346px;
  min-width: 240px;
  max-width: 60%;
  flex: none;
  resize: horizontal;
  overflow: hidden;
  border-right: 0.5px solid var(--border);
}

/* 변경사항 탭: 트리(접이식)와 변경 목록이 세로로 나눈다 */
.changes-side {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.changes-side > :first-child {
  /* 저장된 트리 높이가 창보다 커졌을 때 변경 목록의 자리를 지킨다 */
  max-height: calc(100% - 120px);
}
.changes-side > :last-child {
  flex: 1;
  min-height: 0;
}

/* 트리/변경 목록 사이 분할선. 선은 얇게, 잡는 영역은 넉넉하게 */
.splitter {
  flex: none;
  height: 7px;
  margin: -3px 0;
  cursor: row-resize;
  position: relative;
  z-index: 1;
}
.splitter::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 0;
  right: 0;
  height: 0.5px;
  background: var(--border);
  transition: background var(--fast) var(--ease);
}
.splitter:hover::after,
.splitter:active::after {
  height: 2px;
  background: var(--accent);
}

/* 브랜치 비교: 위에 기준 선택, 아래 파일 목록 */
.compare-side {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.cmp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 0;
  flex: none;
}
.cmp-meta {
  padding: 6px 16px 2px;
  color: var(--fg-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  flex: none;
}
.cmp-filter {
  flex: none;
  margin: 8px 16px 0;
  padding: 5px 10px;
  border-radius: var(--r-sm);
  background: var(--bg-elevated);
  color: var(--fg);
  font-size: 12px;
  border: none;
  outline: none;
}
.cmp-filter:focus {
  box-shadow: 0 0 0 1.5px var(--accent);
}
.cmp-filter::placeholder {
  color: var(--fg-faint);
}
.cmp-files {
  flex: 1;
  min-height: 0;
}

/* 히스토리 탭에서만 좌측을 위아래로 나눈다 */
.history-side {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.commits {
  flex: 1 1 55%;
  min-height: 120px;
  overflow: hidden;
  resize: vertical;
  border-bottom: 0.5px solid var(--border);
}
.commit-detail {
  flex: 1 1 45%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.meta {
  flex: none;
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--border);
  max-height: 30%;
  overflow-y: auto;
}
.meta-line {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
}
.sha {
  font-family: var(--mono);
  color: var(--status-conflicted);
  font-size: 11.5px;
}
.who {
  color: var(--fg-dim);
}
.when {
  color: var(--fg-faint);
}
.subject {
  margin: 5px 0 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.005em;
}
.body-text {
  margin: 6px 0 0;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--fg-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.commit-files {
  flex: 1;
  min-height: 0;
}

/**
 * 화면 전환 — iOS 세그먼티드 컨트롤. 홈 안에 트랙을 깔고 고른 칸만 떠오른다.
 * 두 화면이 대등한 선택지라는 뜻이 모양에 담긴다.
 */
.tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  background: rgba(118, 118, 128, 0.24);
  border-radius: 8px;
}
.tab {
  padding: 3px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-dim);
  border-radius: 6px;
}
.tab:hover {
  color: var(--fg);
}
.tab.on {
  background: var(--bg-elevated);
  color: var(--fg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.empty-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--fg-dim);
}
.empty-main .dim {
  color: var(--fg-faint);
  font-size: 12px;
}
.empty-main p {
  margin: 0;
}
kbd {
  padding: 2px 7px;
  border-radius: var(--r-sm);
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg);
  font-family: var(--ui);
  font-size: 11.5px;
  font-weight: 500;
}

/* ⌘+/⌘- 직후에만 뜨는 배지. 시트처럼 흐림 위에 얹어 코드를 가리지 않는다 */
.font-badge {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 40;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--r-pill);
  background: var(--bg-sheet);
  backdrop-filter: blur(20px);
  box-shadow: var(--shadow-pop);
  color: var(--fg);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.font-badge span {
  color: var(--fg-faint);
  font-size: 10.5px;
}
</style>

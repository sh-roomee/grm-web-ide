<script setup>
import { computed, nextTick, ref, watch } from 'vue'

import FileIcon from './FileIcon.vue'

import * as api from '../api.js'
import { fuzzyScore } from '../lib/fuzzy.js'

/**
 * 통합 검색 (IntelliJ의 Search Everywhere).
 *
 * 여는 방법이 셋이고 각각 다른 탭에서 시작한다:
 *   Shift 두 번 → 전체 · ⌘P → 파일 · ⌘⇧F → 텍스트
 *
 * 파일 목록은 부모가 미리 받아 넘긴다(자주 열리고 잘 안 바뀐다). 커밋과 텍스트는
 * 서버에 물어봐야 하므로 입력이 멈춘 뒤에 요청한다.
 */

const props = defineProps({
  open: { type: Boolean, default: false },
  tab: { type: String, default: 'all' },
  seed: { type: String, default: '' }, // 열 때 미리 채울 검색어 (드래그 선택)
  clear: { type: Boolean, default: false }, // 열 때 검색어를 비운다 (⌘E)
  files: { type: Array, default: () => [] },
  // 최근 본 파일 경로 (최근 순). 검색어가 비었을 때 이 순서로 보여 준다
  recent: { type: Array, default: () => [] },
  // 이름으로 실행할 수 있는 화면 기능 [{ key, label, desc, words }]. App이 정한다
  actions: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'open-file', 'open-commit', 'update:tab', 'add-context', 'action'])

const TABS = [
  { key: 'all', label: '전체' },
  { key: 'file', label: '파일' },
  { key: 'commit', label: '커밋' },
  { key: 'text', label: '텍스트' },
]

const LIST_LIMIT = 60
const PREVIEW_LIMIT = { file: 8, commit: 5, text: 8 } // '전체' 탭에서 종류별 개수
const DEBOUNCE_MS = 200

const term = ref('')
const cursor = ref(0)
const input = ref(null)
const listEl = ref(null)

const commits = ref([])
const textHits = ref([])
const textTruncated = ref(false)
const loading = ref(false)

const trimmed = computed(() => term.value.trim())

/**
 * 액션 — 화면 기능을 이름으로 실행한다 (IntelliJ의 Actions 탭 자리).
 * 목록은 App이 준다 — 무엇을 할 수 있는지는 지금 화면 상태가 정하기 때문이다.
 */
const actionHits = computed(() => {
  const q = trimmed.value.toLowerCase()
  if (!q) return []
  return props.actions.filter(
    (a) => a.label.toLowerCase().includes(q) || a.words.some((w) => w.includes(q)),
  )
})

// --- 파일: 받아둔 목록에서 바로 걸러낸다 (요청 없음)
const fileHits = computed(() => {
  const needle = trimmed.value.toLowerCase().replace(/\s+/g, '')
  /**
   * 검색어가 없으면 **최근 본 파일**을 먼저 놓는다 (⌘E).
   *
   * 전에는 `git ls-files` 순서 앞 60개였는데 그건 아무 뜻이 없는 목록이라, 사실상
   * 검색어를 치기 전까지 빈 화면이었다. 방금 보던 것들이 거기 있으면 오가는 일이
   * 검색 없이 끝난다. 최근 목록에는 지워진 파일이 남을 수 있어 지금 목록에 있는
   * 것만 남긴다.
   */
  if (!needle) {
    const known = new Set(props.files)
    const recent = props.recent.filter((p) => known.has(p))
    const rest = props.files.filter((p) => !recent.includes(p))
    return [...recent, ...rest]
      .slice(0, LIST_LIMIT)
      .map((path) => ({ path, marks: [], parts: [{ text: path, on: false }], recent: recent.includes(path) }))
  }
  const out = []
  for (const path of props.files) {
    const hit = fuzzyScore(path, needle)
    if (hit) out.push({ path, ...hit })
  }
  out.sort((a, b) => b.points - a.points)
  return out.slice(0, LIST_LIMIT)
})

// --- 커밋 / 텍스트: 서버에 물어본다
let debounce = null

async function search() {
  const q = trimmed.value
  if (!q) {
    commits.value = []
    textHits.value = []
    return
  }
  const wants = (kind) => props.tab === 'all' || props.tab === kind
  loading.value = true
  try {
    const jobs = []
    if (wants('commit')) {
      jobs.push(
        api.fetchLog({ limit: 40, q, in: 'message' }).then((r) => {
          if (trimmed.value === q) commits.value = r.commits
        }),
      )
    } else commits.value = []

    if (wants('text')) {
      jobs.push(
        api.fetchGrep(q).then((r) => {
          if (trimmed.value !== q) return
          textHits.value = r.hits
          textTruncated.value = r.truncated
        }),
      )
    } else textHits.value = []

    await Promise.all(jobs)
  } finally {
    loading.value = false
  }
}

watch([term, () => props.tab], () => {
  cursor.value = 0
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(search, DEBOUNCE_MS)
})

/**
 * 탭에 맞는 결과를 한 줄 목록으로 만든다. '전체' 탭은 종류별로 몇 개씩 섞고
 * 사이에 구분 제목을 넣는다 — 키보드 이동은 이 평면 목록을 따라간다.
 */
const rows = computed(() => {
  const out = []
  const push = (items) => out.push(...items)

  const fileRows = (limit) =>
    fileHits.value.slice(0, limit).map((hit) => ({ kind: 'file', key: `f:${hit.path}`, hit }))
  const commitRows = (limit) =>
    commits.value.slice(0, limit).map((c) => ({ kind: 'commit', key: `c:${c.sha}`, commit: c }))
  const textRows = (limit) =>
    textHits.value
      .slice(0, limit)
      .map((h, i) => ({ kind: 'text', key: `t:${h.path}:${h.line}:${i}`, hit: h }))

  const actionRows = () =>
    actionHits.value.map((a) => ({ kind: 'action', key: `a:${a.key}`, action: a }))

  // 검색어가 없으면 파일 목록이 곧 "최근 본 것"이다 — 제목으로 그렇다고 말해 준다
  const fileLabel = trimmed.value ? '파일' : '최근 본 파일'

  if (props.tab === 'file') {
    if (!trimmed.value && props.recent.length) {
      out.push({ kind: 'label', key: 'l:recent', label: fileLabel })
    }
    push(fileRows(LIST_LIMIT))
  } else if (props.tab === 'commit') push(commitRows(LIST_LIMIT))
  else if (props.tab === 'text') push(textRows(LIST_LIMIT))
  else {
    const groups = [
      { label: '액션', items: actionRows() },
      { label: fileLabel, items: fileRows(PREVIEW_LIMIT.file) },
      { label: '커밋', items: commitRows(PREVIEW_LIMIT.commit) },
      { label: '텍스트', items: textRows(PREVIEW_LIMIT.text) },
    ]
    for (const group of groups) {
      if (!group.items.length) continue
      out.push({ kind: 'label', key: `l:${group.label}`, label: group.label })
      push(group.items)
    }
  }
  return out
})

/** 선택 가능한(제목이 아닌) 줄만 */
const pickable = computed(() => rows.value.filter((r) => r.kind !== 'label'))
const current = computed(() => pickable.value[cursor.value] ?? null)

function move(delta) {
  const count = pickable.value.length
  if (!count) return
  cursor.value = (cursor.value + delta + count) % count
  nextTick(() => listEl.value?.querySelector('.row.on')?.scrollIntoView({ block: 'nearest' }))
}

function choose(row = current.value) {
  if (!row) return
  if (row.kind === 'file') emit('open-file', { path: row.hit.path })
  else if (row.kind === 'text') emit('open-file', { path: row.hit.path, line: row.hit.line })
  else if (row.kind === 'commit') emit('open-commit', row.commit.sha)
  else if (row.kind === 'action') emit('action', row.action.key)
  emit('close')
}

/**
 * 결과를 열지 않고 **컨텍스트 바구니에 담는다** (⌥Enter).
 *
 * 검색은 대개 "이 파일도 AI가 봐야 한다"를 찾는 일이라, 찾은 자리에서 바로 담는
 * 길이 없으면 사람이 경로를 손으로 옮겨 적게 된다. 창은 닫지 않는다 — 보통 여러
 * 개를 이어서 담는다.
 *
 * 텍스트 검색 결과는 **그 파일**을 담는다. 한 줄만 넘기면 AI가 앞뒤를 볼 수 없다.
 * 검색어 자체를 담고 싶으면 아래 `검색 담기`를 쓴다 (넘길 때 다시 검색한다).
 */
function stash(row = current.value) {
  if (!row) return
  if (row.kind === 'file' || row.kind === 'text') {
    emit('add-context', { kind: 'file', path: row.hit.path })
  }
}

function cycleTab(delta) {
  const at = TABS.findIndex((t) => t.key === props.tab)
  emit('update:tab', TABS[(at + delta + TABS.length) % TABS.length].key)
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    if (props.seed) term.value = props.seed
    else if (props.clear) term.value = '' // ⌘E — 최근 목록을 보려고 연 것이다
    cursor.value = 0
    await nextTick()
    input.value?.select()
    if (debounce) clearTimeout(debounce) // term 변경 watcher가 예약한 중복 검색 취소
    if (trimmed.value) search()
  },
)

/** 현재 줄의 전체 경로 등을 아래에 보여준다 */
const footPath = computed(() => {
  const row = current.value
  if (!row) return ''
  if (row.kind === 'action') return row.action.desc
  if (row.kind === 'file') return row.hit.path
  if (row.kind === 'text') return `${row.hit.path}:${row.hit.line}`
  if (row.kind === 'commit') return `${row.commit.shortSha} · ${row.commit.author}`
  return ''
})

const isSelected = (row) => pickable.value[cursor.value]?.key === row.key
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="palette">
      <nav class="tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ on: tab === t.key }"
          @click="emit('update:tab', t.key)"
        >
          {{ t.label }}
        </button>
        <span class="spacer" />
        <span v-if="loading" class="loading">검색 중…</span>
        <span class="hint">Tab 으로 탭 이동</span>
      </nav>

      <input
        ref="input"
        v-model="term"
        class="input"
        type="text"
        :placeholder="
          tab === 'text'
            ? '저장소 전체에서 텍스트 찾기 (git grep)'
            : tab === 'commit'
              ? '커밋 메시지 찾기'
              : tab === 'file'
                ? '파일 경로 일부 — 비워 두면 최근 본 파일'
                : '파일 · 커밋 · 텍스트 · 액션을 한 번에'
        "
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.exact.prevent="choose()"
        @keydown.enter.alt.prevent="stash()"
        @keydown.esc.prevent="emit('close')"
        @keydown.tab.exact.prevent="cycleTab(1)"
        @keydown.tab.shift.prevent="cycleTab(-1)"
      />

      <div ref="listEl" class="list">
        <template v-for="row in rows" :key="row.key">
          <div v-if="row.kind === 'label'" class="group">{{ row.label }}</div>

          <button
            v-else
            class="row"
            :class="{ on: isSelected(row) }"
            @click="choose(row)"
            @mousemove="cursor = pickable.findIndex((p) => p.key === row.key)"
          >
            <!-- 액션 — 이름으로 실행하는 화면 기능 -->
            <template v-if="row.kind === 'action'">
              <span class="icon act">›_</span>
              <span class="main">{{ row.action.label }}</span>
              <span class="side">{{ row.action.desc }}</span>
            </template>

            <!-- 파일 — 종류 아이콘이 곧 "파일 결과"라는 표시다 -->
            <template v-else-if="row.kind === 'file'">
              <FileIcon :path="row.hit.path" />
              <span class="main mono"
                ><span
                  v-for="(part, i) in row.hit.parts"
                  :key="i"
                  :class="{ mark: part.on }"
                  >{{ part.text }}</span
                ></span
              >
            </template>

            <!-- 커밋 -->
            <template v-else-if="row.kind === 'commit'">
              <span class="icon commit">C</span>
              <span class="main">{{ row.commit.subject }}</span>
              <span class="side mono">{{ row.commit.shortSha }}</span>
              <span class="side">{{ row.commit.relativeDate }}</span>
            </template>

            <!-- 텍스트 -->
            <template v-else>
              <span class="icon text">T</span>
              <span class="main mono">{{ row.hit.text.trim() }}</span>
              <span class="side mono">{{ row.hit.path }}:{{ row.hit.line }}</span>
            </template>
          </button>
        </template>

        <p v-if="!rows.length && trimmed && !loading" class="none">결과가 없습니다.</p>
        <p v-else-if="!rows.length && !trimmed" class="none">
          찾을 내용을 입력하세요. 파일 이름 일부, 커밋 메시지, 코드, 화면 기능 이름
          어느 쪽이든 됩니다.
        </p>
        <p v-if="textTruncated && (tab === 'text' || tab === 'all')" class="cut">
          텍스트 결과가 너무 많아 일부만 보여줍니다. 검색어를 좁혀 주세요.
        </p>
      </div>

      <footer class="foot">
        <span class="mono ellipsis">{{ footPath }}</span>
        <button
          v-if="tab === 'text' && trimmed"
          class="stash-query"
          title="검색어를 컨텍스트에 담는다. 넘길 때 다시 검색하므로 결과가 낡지 않는다"
          @click="emit('add-context', { kind: 'grep', query: trimmed })"
        >
          검색 담기
        </button>
        <span class="keys">↑↓ 이동 · Enter 열기 · ⌥Enter 담기 · Esc 닫기</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 통합 검색 — iOS 시트. 뒤를 흐리게 눌러 층을 만든다 */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  justify-content: center;
  padding-top: 10vh;
  animation: fade 160ms var(--ease);
}
@keyframes fade {
  from {
    opacity: 0;
  }
}

.palette {
  width: min(760px, 92vw);
  max-height: 74vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-sheet);
  backdrop-filter: saturate(180%) blur(30px);
  -webkit-backdrop-filter: saturate(180%) blur(30px);
  border: 0.5px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-sheet);
  overflow: hidden;
  animation: rise 200ms var(--ease);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.98);
  }
}

.tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 9px 12px;
  border-bottom: 0.5px solid var(--border);
}
.tab {
  padding: 3px 11px;
  color: var(--fg-dim);
  font-size: 12.5px;
  font-weight: 500;
  border-radius: var(--r-pill);
}
.tab:hover {
  color: var(--fg);
}
.tab.on {
  background: var(--accent);
  color: #fff;
}
.spacer {
  flex: 1;
}
.loading,
.stash-query {
  flex: none;
  padding: 2px 10px;
  border-radius: var(--r-pill);
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-dim);
  font-size: 11px;
}
.stash-query:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.hint {
  color: var(--fg-faint);
  font-size: 11px;
  padding-bottom: 6px;
}
.loading {
  margin-right: 8px;
  color: var(--accent);
}

.input {
  flex: none;
  margin: 10px 12px;
  padding: 8px 13px;
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg);
  border: none;
  border-radius: var(--r-pill);
  font: inherit;
  font-size: 15px;
  outline: none;
}
.input::placeholder {
  color: var(--fg-faint);
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}

.group {
  padding: 7px 12px 3px;
  color: var(--fg-faint);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 5px 12px;
  text-align: left;
  min-width: 0;
}
.row.on {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}
.row.on .main {
  color: #fff;
}

.icon {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  font-size: 9.5px;
  line-height: 15px;
  text-align: center;
  font-weight: 700;
  color: var(--bg);
}
.icon.file {
  background: var(--accent);
  color: #fff;
}
.icon.act {
  background: var(--icon-indigo);
  color: #fff;
  font-size: 8px;
  font-family: var(--mono);
}
.icon.commit {
  background: var(--status-conflicted);
  color: #241802;
}
.icon.text {
  background: var(--status-added);
  color: #04220d;
}

.main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.mono {
  font-family: var(--mono);
}
.mark {
  color: var(--fg);
  font-weight: 700;
}
.main:not(.mark) {
  color: var(--fg-dim);
}

.side {
  flex: none;
  color: var(--fg-faint);
  font-size: 11px;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}

.none,
.cut {
  padding: 12px 14px;
  color: var(--fg-faint);
  font-size: 12px;
}
.cut {
  color: var(--status-conflicted);
}

.foot {
  flex: none;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 14px;
  border-top: 0.5px solid var(--border);
  color: var(--fg-faint);
  font-size: 11px;
  min-width: 0;
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.keys {
  white-space: nowrap;
}
</style>

<script setup>
import { computed } from 'vue'

import RefPicker from './RefPicker.vue'

const props = defineProps({
  commits: { type: Array, required: true },
  laneCount: { type: Number, default: 1 },
  selected: { type: String, default: null }, // 선택한 커밋 sha
  loading: { type: Boolean, default: false },
  hasMore: { type: Boolean, default: false },
  // 검색 결과는 위상이 끊겨 그래프를 그리지 않는다
  filtered: { type: Boolean, default: false },
  refs: { type: Array, default: () => [] },
  activeRef: { type: String, default: null },
  query: { type: String, default: '' },
  searchIn: { type: String, default: 'message' },
})

const emit = defineEmits([
  'select',
  'more',
  'update:activeRef',
  'update:query',
  'update:searchIn',
])

const SEARCH_MODES = [
  { key: 'message', label: '메시지' },
  { key: 'author', label: '작성자' },
  { key: 'content', label: '코드 내용' },
  { key: 'path', label: '경로' },
]

const SEARCH_HINT = {
  message: '커밋 메시지 검색',
  author: '작성자 검색',
  content: '이 문자열이 생기거나 사라진 커밋 (git log -S)',
  path: '이 경로를 건드린 커밋',
}

const ROW_HEIGHT = 26
const LANE_WIDTH = 14
const DOT_R = 3.5

// 레인마다 색을 돌려 쓴다. 브랜치를 눈으로 따라가려면 색이 필요하다.
// iOS 시스템 컬러. 브랜치를 눈으로 따라가려면 색이 필요하고, 화면의 나머지와
// 같은 팔레트를 써야 따로 튀지 않는다.
const LANE_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#40c8e0', '#ff453a']
const laneColor = (lane) => LANE_COLORS[lane % LANE_COLORS.length]

const graphWidth = computed(() => Math.max(1, props.laneCount) * LANE_WIDTH + 6)
const laneX = (lane) => lane * LANE_WIDTH + LANE_WIDTH / 2

/**
 * 한 행에 그릴 선들을 만든다.
 *
 *  - `lanesAbove` ∩ `lanesBelow` → 이 행을 그대로 통과하는 선 (수직)
 *  - `lanesAbove` 중 아래로 안 이어지는 것 → 이 커밋으로 합쳐지는 선 (위→중앙)
 *  - `parentLanes` 중 자기 레인이 아닌 것 → 아래로 갈라지는 선 (중앙→아래)
 */
function rowLines(commit) {
  const lines = []
  const mid = ROW_HEIGHT / 2
  const x = laneX(commit.lane)

  for (const lane of commit.lanesAbove) {
    const passes = commit.lanesBelow.includes(lane)
    if (lane === commit.lane) {
      lines.push({ d: `M ${x} 0 L ${x} ${mid}`, color: laneColor(lane) })
      continue
    }
    if (passes) {
      const lx = laneX(lane)
      lines.push({ d: `M ${lx} 0 L ${lx} ${ROW_HEIGHT}`, color: laneColor(lane) })
    } else {
      // 이 커밋으로 합쳐진다
      const lx = laneX(lane)
      lines.push({ d: `M ${lx} 0 L ${lx} ${mid * 0.4} Q ${lx} ${mid} ${x} ${mid}`, color: laneColor(lane) })
    }
  }

  for (const lane of commit.parentLanes) {
    const lx = laneX(lane)
    if (lane === commit.lane) {
      lines.push({ d: `M ${x} ${mid} L ${x} ${ROW_HEIGHT}`, color: laneColor(lane) })
    } else {
      // 아래로 갈라져 나간다
      lines.push({
        d: `M ${x} ${mid} Q ${lx} ${mid} ${lx} ${mid * 1.6} L ${lx} ${ROW_HEIGHT}`,
        color: laneColor(lane),
      })
    }
  }

  return lines
}

const rows = computed(() =>
  props.commits.map((commit) => ({
    commit,
    lines: rowLines(commit),
    x: laneX(commit.lane),
    color: laneColor(commit.lane),
  })),
)

const REF_CLASS = {
  head: 'ref-head',
  branch: 'ref-branch',
  remote: 'ref-remote',
  tag: 'ref-tag',
}
</script>

<template>
  <div class="commit-list">
    <header class="list-header">
      <span class="title">히스토리</span>
      <span class="count">
        {{ commits.length }}{{ hasMore ? '+' : '' }} {{ filtered ? '건' : '커밋' }}
      </span>
      <RefPicker
        class="ref-picker"
        :refs="refs"
        :selected="activeRef"
        @select="emit('update:activeRef', $event)"
      />
    </header>

    <div class="search">
      <select
        class="mode"
        :value="searchIn"
        title="검색 대상"
        @change="emit('update:searchIn', $event.target.value)"
      >
        <option v-for="mode in SEARCH_MODES" :key="mode.key" :value="mode.key">
          {{ mode.label }}
        </option>
      </select>

      <input
        class="term"
        type="search"
        :value="query"
        :placeholder="SEARCH_HINT[searchIn]"
        :title="SEARCH_HINT[searchIn]"
        @input="emit('update:query', $event.target.value)"
        @keydown.esc="emit('update:query', '')"
      />

      <button v-if="query" class="clear" title="검색 지우기" @click="emit('update:query', '')">
        ✕
      </button>
    </div>

    <p v-if="filtered" class="filter-note">
      검색 결과는 앞뒤 커밋이 빠져 있어 브랜치 선을 그리지 않습니다.
    </p>

    <div class="scroll">
      <p v-if="loading && !commits.length" class="empty">불러오는 중…</p>
      <p v-else-if="!commits.length && query" class="empty">
        일치하는 커밋이 없습니다.<br />
        <span class="hint">{{ SEARCH_HINT[searchIn] }}로 찾고 있습니다.</span>
      </p>
      <p v-else-if="!commits.length" class="empty">커밋이 없습니다.</p>

      <button
        v-for="row in rows"
        :key="row.commit.sha"
        class="row"
        :class="{ active: row.commit.sha === selected }"
        @click="emit('select', row.commit)"
      >
        <svg
          class="graph"
          :width="graphWidth"
          :height="ROW_HEIGHT"
          :viewBox="`0 0 ${graphWidth} ${ROW_HEIGHT}`"
        >
          <path
            v-for="(line, i) in row.lines"
            :key="i"
            :d="line.d"
            :stroke="line.color"
            fill="none"
            stroke-width="1.5"
          />
          <circle
            :cx="row.x"
            :cy="ROW_HEIGHT / 2"
            :r="row.commit.isMerge ? DOT_R - 1 : DOT_R"
            :fill="row.commit.isMerge ? 'var(--bg)' : row.color"
            :stroke="row.color"
            stroke-width="1.5"
          />
        </svg>

        <span class="refs">
          <span
            v-for="ref in row.commit.refs"
            :key="ref.name"
            class="ref"
            :class="REF_CLASS[ref.type]"
            >{{ ref.name }}</span
          >
        </span>

        <span class="subject" :title="row.commit.subject">{{ row.commit.subject }}</span>
        <span class="author">{{ row.commit.author }}</span>
        <span class="date">{{ row.commit.relativeDate }}</span>
      </button>

      <button v-if="hasMore" class="more" :disabled="loading" @click="emit('more')">
        {{ loading ? '불러오는 중…' : '더 보기' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.commit-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

.list-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 14px 8px;
  flex: none;
}
.title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.count {
  color: var(--fg-faint);
  white-space: nowrap;
}
.ref-picker {
  margin-left: auto;
}

.search {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 12px 9px;
  flex: none;
}
.mode {
  flex: none;
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-dim);
  border: none;
  border-radius: var(--r-sm);
  font: inherit;
  font-size: 11.5px;
  padding: 3px 4px;
  outline: none;
}
.term {
  flex: 1;
  min-width: 0;
  padding: 4px 11px;
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg);
  border: none;
  border-radius: var(--r-pill);
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.term:focus {
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.term::-webkit-search-cancel-button {
  display: none;
}
.clear {
  flex: none;
  padding: 0 5px;
  color: var(--fg-faint);
}
.clear:hover {
  color: var(--fg);
}

.filter-note {
  flex: none;
  margin: 0 10px 6px;
  padding: 6px 11px;
  background: rgba(255, 159, 10, 0.12);
  color: var(--status-conflicted);
  font-size: 11.5px;
  border-radius: var(--r-sm);
}

.hint {
  color: var(--fg-faint);
  font-size: 11px;
}

.scroll {
  flex: 1;
  overflow-y: auto;
}

.empty {
  padding: 16px 12px;
  color: var(--fg-faint);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 10px 0 0;
  text-align: left;
  min-width: 0;
}
.row:hover {
  background: var(--bg-elevated);
}
.row.active {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}
.row.active .subject {
  color: #fff;
  font-weight: 590;
}

.graph {
  flex: none;
  display: block;
}

.refs {
  flex: none;
  display: flex;
  gap: 4px;
}
.ref {
  padding: 0 7px;
  border-radius: var(--r-pill);
  font-size: 10.5px;
  font-weight: 590;
  line-height: 16px;
  white-space: nowrap;
}
.ref-head {
  background: rgba(48, 209, 88, 0.2);
  color: var(--status-added);
}
.ref-branch {
  background: var(--accent-soft);
  color: var(--accent);
}
.ref-remote {
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-dim);
}
.ref-tag {
  background: rgba(255, 159, 10, 0.18);
  color: var(--status-conflicted);
}

.subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.author {
  flex: none;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dim);
  font-size: 11px;
}
.date {
  flex: none;
  color: var(--fg-faint);
  font-size: 11px;
  white-space: nowrap;
}

.more {
  width: 100%;
  padding: 8px;
  color: var(--fg-dim);
}
.more:hover {
  background: var(--bg-elevated);
  color: var(--fg);
}
</style>

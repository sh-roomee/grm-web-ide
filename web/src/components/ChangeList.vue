<script setup>
import { computed } from 'vue'

const props = defineProps({
  groups: { type: Array, required: true }, // [{ key, title, files }]
  selected: { type: Object, default: null },
  // 커밋 파일 목록으로도 쓴다. 그때는 확인 체크와 stage 동작이 의미가 없다.
  readonly: { type: Boolean, default: false },
  isReviewed: { type: Function, default: () => false },
  // 기준점 이후 바뀌고 아직 확인 안 한 파일 표시
  isFresh: { type: Function, default: () => false },
  // 파일별 위험 신호: (path) => [{label, count}] | null
  risksFor: { type: Function, default: () => null },
  title: { type: String, default: 'Changes' },
  countLabel: { type: String, default: 'files' },
})

const emit = defineEmits(['select', 'toggle-review', 'stage', 'unstage', 'review-all'])

const STATUS_CHAR = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: '?',
  conflicted: '!',
}

function fileName(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirName(path) {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

const isSame = (a, b) => a && b && a.path === b.path && a.staged === b.staged

const totalCount = computed(() => props.groups.reduce((n, g) => n + g.files.length, 0))
</script>

<template>
  <div class="change-list">
    <header class="list-header">
      <span class="title">{{ title }}</span>
      <span class="count">{{ totalCount }} {{ countLabel }}</span>
      <slot name="header" />
    </header>

    <div class="scroll">
      <p v-if="totalCount === 0" class="empty">변경사항이 없습니다.</p>

      <section v-for="group in groups" :key="group.key" class="group">
        <template v-if="group.files.length">
          <div v-if="group.title" class="group-header">
            <span>{{ group.title }}</span>
            <span class="group-count">{{ group.files.length }}</span>
            <button
              v-if="!readonly"
              class="group-action"
              title="이 그룹 전체를 확인함으로 표시"
              @click="emit('review-all', group)"
            >
              그룹 확인
            </button>
          </div>

          <button
            v-for="file in group.files"
            :key="`${group.key}:${file.path}`"
            class="row"
            :class="{ active: isSame(file, selected), reviewed: isReviewed(file) }"
            @click="emit('select', file)"
          >
            <input
              v-if="!readonly"
              class="check"
              type="checkbox"
              :checked="isReviewed(file)"
              title="확인함"
              @click.stop
              @change="emit('toggle-review', file)"
            />
            <span class="status" :class="`s-${file.status}`">{{ STATUS_CHAR[file.status] ?? '·' }}</span>
            <span v-if="isFresh(file)" class="fresh" title="마지막으로 확인한 뒤에 바뀌었다" />
            <span
              v-if="risksFor(file.path)"
              class="risk"
              :title="
                risksFor(file.path)
                  .map((r) => `${r.label} ${r.count}`)
                  .join(' · ')
              "
              >⚠</span
            >
            <span class="name">{{ fileName(file.path) }}</span>
            <span class="dir">{{ dirName(file.path) }}</span>
            <span class="stat">
              <span v-if="file.additions" class="plus">+{{ file.additions }}</span>
              <span v-if="file.deletions" class="minus">-{{ file.deletions }}</span>
              <span v-if="file.additions === null" class="bin">bin</span>
            </span>
            <span
              v-if="!readonly"
              class="stage-action"
              :title="file.staged ? 'unstage' : 'stage'"
              @click.stop="emit(file.staged ? 'unstage' : 'stage', file)"
            >
              {{ file.staged ? '−' : '+' }}
            </span>
          </button>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.change-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
}

.list-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.title {
  font-weight: 600;
}
.count {
  color: var(--fg-faint);
}

.scroll {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 12px;
}

.empty {
  color: var(--fg-faint);
  padding: 16px 12px;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 4px;
  color: var(--fg-dim);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  position: sticky;
  top: 0;
  background: var(--bg-panel);
  z-index: 1;
}
.group-count {
  color: var(--fg-faint);
}
.group-action {
  margin-left: auto;
  color: var(--fg-faint);
  text-transform: none;
  letter-spacing: 0;
}
.group-action:hover {
  color: var(--accent);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 12px 3px 8px;
  text-align: left;
  min-width: 0;
}
.row:hover {
  background: var(--bg-elevated);
}
.row.active {
  background: #2f4870;
}
.row.reviewed .name,
.row.reviewed .dir {
  opacity: 0.45;
}

.check {
  flex: none;
  accent-color: var(--accent);
  margin: 0;
}

.status {
  flex: none;
  width: 12px;
  text-align: center;
  font-family: var(--mono);
  font-weight: 700;
}
.s-added {
  color: var(--status-added);
}
.s-modified,
.s-renamed,
.s-copied,
.s-typechange {
  color: var(--status-modified);
}
.s-deleted {
  color: var(--status-deleted);
}
.s-untracked {
  color: var(--status-untracked);
}
.s-conflicted {
  color: var(--status-conflicted);
}

/* 사람이 놓치기 쉬운 지점이 있는 파일 */
.risk {
  flex: none;
  font-size: 10px;
  color: var(--status-conflicted);
  cursor: help;
}

/* 마지막으로 확인한 뒤 바뀐 파일 */
.fresh {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #e8c88a;
  margin-left: -2px;
}

.name {
  flex: none;
  white-space: nowrap;
}
.dir {
  color: var(--fg-faint);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl; /* 경로가 길면 뒤쪽(구체적인 부분)이 남도록 */
  text-align: left;
  flex: 1;
  min-width: 0;
}

.stat {
  flex: none;
  display: flex;
  gap: 4px;
  font-family: var(--mono);
  font-size: 11px;
}
.plus {
  color: var(--status-added);
}
.minus {
  color: var(--status-deleted);
}
.bin {
  color: var(--fg-faint);
}

.stage-action {
  flex: none;
  width: 16px;
  text-align: center;
  color: var(--fg-faint);
  font-family: var(--mono);
  visibility: hidden;
}
.row:hover .stage-action {
  visibility: visible;
}
.stage-action:hover {
  color: var(--accent);
}
</style>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  groups: { type: Array, required: true }, // [{ key, title, files }]
  selected: { type: Object, default: null },
  isReviewed: { type: Function, required: true },
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
      <span class="title">Changes</span>
      <span class="count">{{ totalCount }} files</span>
    </header>

    <div class="scroll">
      <p v-if="totalCount === 0" class="empty">변경사항이 없습니다.</p>

      <section v-for="group in groups" :key="group.key" class="group">
        <template v-if="group.files.length">
          <div class="group-header">
            <span>{{ group.title }}</span>
            <span class="group-count">{{ group.files.length }}</span>
            <button
              class="group-action"
              title="이 그룹 전체를 확인함으로 표시"
              @click="emit('review-all', group)"
            >
              전체 확인
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
              class="check"
              type="checkbox"
              :checked="isReviewed(file)"
              title="확인함"
              @click.stop
              @change="emit('toggle-review', file)"
            />
            <span class="status" :class="`s-${file.status}`">{{ STATUS_CHAR[file.status] ?? '·' }}</span>
            <span class="name">{{ fileName(file.path) }}</span>
            <span class="dir">{{ dirName(file.path) }}</span>
            <span class="stat">
              <span v-if="file.additions" class="plus">+{{ file.additions }}</span>
              <span v-if="file.deletions" class="minus">-{{ file.deletions }}</span>
              <span v-if="file.additions === null" class="bin">bin</span>
            </span>
            <span
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

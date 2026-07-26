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

          <div class="card">
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
              <span v-if="file.link" class="bin" :title="`심볼릭 링크 → ${file.link}`">링크</span>
              <span v-else-if="file.additions === null" class="bin">bin</span>
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
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
/**
 * 파일 목록 — iOS 설정 앱의 inset grouped list.
 *
 * 왜 이 모양인가: 44개 파일을 훑는 화면이다. 줄이 빽빽하게 이어지면 벽이 되고,
 * 그룹이 카드로 떨어져 있으면 "여기부터 staged"가 눈에 먼저 들어온다.
 * 목록 스캔에 특화된 형태라 이 화면의 일과 맞는다.
 */
.change-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.list-header {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 12px 16px 8px;
  flex: none;
}
.title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.count {
  color: var(--fg-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 16px;
}

.empty {
  color: var(--fg-faint);
  padding: 14px 6px;
  font-size: 13px;
}

/* 그룹 제목은 카드 밖에. iOS 설정의 섹션 헤더와 같은 자리다 */
.group-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 14px 6px 6px;
  color: var(--fg-dim);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.group-count {
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
}
.group-action {
  margin-left: auto;
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 500;
}
.group-action:hover {
  opacity: 0.75;
}

/* 그룹 = 카드. 첫 행과 마지막 행만 둥글다 */
.group {
  display: block;
}
.card {
  background: var(--bg-panel);
  border-radius: var(--r-md);
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 11px;
  text-align: left;
  min-width: 0;
  position: relative;
}
/* 행 사이 구분선은 왼쪽 여백을 띄운다 — iOS 목록의 특징 */
.row + .row::before {
  content: '';
  position: absolute;
  left: 32px;
  right: 0;
  top: 0;
  height: 0.5px;
  background: var(--border);
}
.row:hover {
  background: var(--bg-elevated);
}
/* macOS 사이드바처럼 반투명 강조. 꽉 찬 파랑은 44줄을 훑을 때 피곤하다 */
.row.active {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}
.row.active .name {
  color: #fff;
  font-weight: 590;
}
.row.reviewed .name,
.row.reviewed .dir {
  opacity: 0.4;
}

.check {
  flex: none;
  appearance: none;
  width: 15px;
  height: 15px;
  margin: 0;
  border-radius: 50%;
  border: 1.5px solid var(--fg-faint);
  cursor: pointer;
  transition: all var(--fast) var(--ease);
}
.check:checked {
  background: var(--status-added);
  border-color: var(--status-added);
}
/* 가운데 체크 표시 */
.check:checked::after {
  content: '';
  display: block;
  width: 4px;
  height: 7px;
  margin: 1.5px 0 0 4px;
  border: solid #04220d;
  border-width: 0 1.6px 1.6px 0;
  transform: rotate(42deg);
}


.status {
  flex: none;
  width: 13px;
  text-align: center;
  font-family: var(--mono);
  font-size: 10.5px;
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
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin-left: -1px;
}


.name {
  flex: none;
  font-size: 13px;
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
  gap: 5px;
  font-family: var(--mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
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
  width: 18px;
  height: 18px;
  line-height: 17px;
  text-align: center;
  border-radius: 50%;
  color: var(--fg-dim);
  font-family: var(--mono);
  background: rgba(118, 118, 128, 0.24);
  visibility: hidden;
}
.row:hover .stage-action {
  visibility: visible;
}
.stage-action:hover {
  background: var(--accent);
  color: #fff;
}
</style>

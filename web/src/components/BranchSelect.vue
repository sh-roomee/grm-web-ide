<script setup>
import { computed, nextTick, ref, watch } from 'vue'

/**
 * "비교할 브랜치 선택" 팝업 — IntelliJ의 Compare with Branch가 띄우는 그 목록.
 *
 * RefPicker는 트리거에 붙는 드롭다운이라 "파일을 보다가 우클릭"처럼 트리거가
 * 없는 자리에서는 쓸 수 없다. 여기는 화면 가운데 뜨는 독립 팝업이고, 무엇을
 * 비교할지는 부모가 안다 — 이 컴포넌트는 브랜치 하나를 고르는 일만 한다.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  refs: { type: Array, default: () => [] }, // { name, kind, shortSha, relativeDate, current }
})

const emit = defineEmits(['close', 'select'])

const KIND_LABEL = { local: '로컬 브랜치', remote: '원격 브랜치', tag: '태그' }

const filter = ref('')
const cursor = ref(0)
const input = ref(null)
const listEl = ref(null)

const matched = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  // 현재 브랜치는 비교 대상으로 뜻이 없다 (자기 자신과의 비교)
  const usable = props.refs.filter((r) => !r.current)
  return needle ? usable.filter((r) => r.name.toLowerCase().includes(needle)) : usable
})

const groups = computed(() =>
  ['local', 'remote', 'tag']
    .map((kind) => ({ kind, label: KIND_LABEL[kind], items: matched.value.filter((r) => r.kind === kind) }))
    .filter((g) => g.items.length),
)

watch([filter, () => props.open], () => (cursor.value = 0))

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) {
      filter.value = ''
      return
    }
    await nextTick()
    input.value?.focus()
  },
)

const isCursor = (item) => matched.value[cursor.value]?.name === item.name

function move(delta) {
  const count = matched.value.length
  if (!count) return
  cursor.value = (cursor.value + delta + count) % count
  nextTick(() => listEl.value?.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' }))
}

function choose(name = matched.value[cursor.value]?.name) {
  if (!name) return
  emit('select', name)
  emit('close')
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="pop">
      <p class="title">비교할 브랜치 선택</p>
      <input
        ref="input"
        v-model="filter"
        class="filter"
        type="text"
        placeholder="브랜치·태그 이름"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="choose()"
        @keydown.esc.prevent="emit('close')"
      />

      <div ref="listEl" class="list">
        <template v-for="group in groups" :key="group.kind">
          <div class="group">{{ group.label }}</div>
          <button
            v-for="item in group.items"
            :key="`${group.kind}:${item.name}`"
            class="item"
            :class="{ on: isCursor(item) }"
            :title="item.name"
            @click="choose(item.name)"
            @mousemove="cursor = matched.findIndex((m) => m.name === item.name)"
          >
            <span class="name">{{ item.name }}</span>
            <span class="meta">{{ item.shortSha }} · {{ item.relativeDate }}</span>
          </button>
        </template>
        <p v-if="!matched.length" class="none">일치하는 브랜치가 없습니다.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  justify-content: center;
  padding-top: 14vh;
  background: rgba(0, 0, 0, 0.3);
}

.pop {
  width: 420px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  align-self: flex-start;
  background: var(--bg-sheet);
  backdrop-filter: saturate(180%) blur(30px);
  -webkit-backdrop-filter: saturate(180%) blur(30px);
  border: 0.5px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-sheet);
  overflow: hidden;
}

.title {
  padding: 12px 14px 0;
  font-size: 13px;
  font-weight: 700;
  text-align: center;
  flex: none;
}

.filter {
  flex: none;
  margin: 10px 12px;
  padding: 6px 11px;
  border-radius: var(--r-sm);
  background: var(--bg-elevated);
  color: var(--fg);
  font-size: 13px;
  border: none;
  outline: none;
}
.filter::placeholder {
  color: var(--fg-faint);
}

.list {
  overflow-y: auto;
  padding: 0 6px 8px;
}

.group {
  padding: 8px 8px 4px;
  color: var(--fg-faint);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 5px 9px;
  border-radius: var(--r-sm);
  text-align: left;
  font-size: 12.5px;
}
.item.on {
  background: var(--accent);
  color: #fff;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  flex: none;
  color: var(--fg-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.item.on .meta {
  color: rgba(255, 255, 255, 0.7);
}

.none {
  padding: 12px 10px;
  color: var(--fg-faint);
  font-size: 12.5px;
}
</style>

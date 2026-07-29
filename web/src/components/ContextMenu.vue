<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

/**
 * 우클릭 컨텍스트 메뉴 — IDE의 편집기 메뉴 자리.
 *
 * 무엇을 담을지는 부모(App)가 정하고, 여기는 그리기와 닫힘 규칙만 안다.
 * 하위 메뉴는 한 단계다(`children`) — `Git ▸ 브랜치 비교`처럼 묶어서,
 * 앞으로 기능이 늘어도 메뉴가 세로로 길어지지 않는다.
 *
 * @prop menu { x, y, sections: [{ items: [{ key, label, hint?, disabled?, children? }] }] }
 */
const props = defineProps({
  menu: { type: Object, required: true },
})

const emit = defineEmits(['close', 'pick'])

const el = ref(null)

/** 화면 밖으로 나가지 않게 자리를 잡는다. 크기는 그려 본 뒤에 안다. */
const pos = ref({ left: 0, top: 0 })
onMounted(() => {
  const rect = el.value?.getBoundingClientRect()
  const w = rect?.width ?? 220
  const h = rect?.height ?? 200
  pos.value = {
    left: Math.max(8, Math.min(props.menu.x, window.innerWidth - w - 8)),
    top: Math.max(8, Math.min(props.menu.y, window.innerHeight - h - 8)),
  }
})

function onDocDown(event) {
  if (el.value && !el.value.contains(event.target)) emit('close')
}
function onKey(event) {
  if (event.key === 'Escape') emit('close')
}
onMounted(() => {
  // mousedown이어야 한다 — click을 기다리면 드래그 시작에도 메뉴가 남는다
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onKey)
  window.addEventListener('blur', () => emit('close'), { once: true })
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onKey)
})

const style = computed(() => ({ left: `${pos.value.left}px`, top: `${pos.value.top}px` }))

function pick(item) {
  if (item.disabled || item.children) return
  emit('pick', item.key)
  emit('close')
}
</script>

<template>
  <div ref="el" class="ctx-menu" :style="style" role="menu" @contextmenu.prevent>
    <template v-for="(section, si) in menu.sections" :key="si">
      <div v-if="si > 0" class="rule" />
      <div
        v-for="item in section.items"
        :key="item.key"
        class="item"
        :class="{ disabled: item.disabled, sub: item.children }"
        role="menuitem"
        @click="pick(item)"
      >
        <span class="label">{{ item.label }}</span>
        <span v-if="item.hint" class="hint">{{ item.hint }}</span>
        <span v-if="item.children" class="arrow">›</span>

        <!-- 하위 메뉴 (한 단계). hover로 펼친다 -->
        <div v-if="item.children" class="ctx-menu submenu" role="menu">
          <div
            v-for="child in item.children"
            :key="child.key"
            class="item"
            :class="{ disabled: child.disabled }"
            role="menuitem"
            @click.stop="pick(child)"
          >
            <span class="label">{{ child.label }}</span>
            <span v-if="child.hint" class="hint">{{ child.hint }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 190px;
  padding: 5px;
  border-radius: var(--r-md);
  background: var(--bg-sheet);
  backdrop-filter: blur(24px);
  border: 0.5px solid var(--border-strong);
  box-shadow: var(--shadow-pop);
  user-select: none;
}

.item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 10px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  color: var(--fg);
  cursor: default;
  white-space: nowrap;
}
.item:hover:not(.disabled) {
  background: var(--accent);
  color: #fff;
}
.item.disabled {
  color: var(--fg-faint);
}

.label {
  flex: 1;
}
.hint {
  color: var(--fg-faint);
  font-size: 11px;
}
.item:hover:not(.disabled) .hint {
  color: rgba(255, 255, 255, 0.7);
}
.arrow {
  color: var(--fg-faint);
  font-size: 13px;
}
.item:hover .arrow {
  color: #fff;
}

.rule {
  height: 0.5px;
  margin: 5px 8px;
  background: var(--border-strong);
}

/* 하위 메뉴 — 부모 항목 오른쪽에 hover로 */
.submenu {
  display: none;
  position: absolute;
  left: calc(100% - 4px);
  top: -5px;
}
.item.sub:hover > .submenu {
  display: block;
}
</style>

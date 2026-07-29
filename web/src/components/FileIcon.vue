<script setup>
import { computed } from 'vue'
import { iconFor } from '../icons/index.js'

/**
 * 파일 아이콘 배지. 어떤 아이콘인지는 `icons/index.js` 레지스트리가 정하고,
 * 여기는 그리기만 한다 — 목록·트리·탭·검색이 전부 이 한 곳을 쓴다.
 */
const props = defineProps({
  path: { type: String, default: '' },
  folder: { type: Boolean, default: false },
})

const icon = computed(() => (props.folder ? null : iconFor(props.path)))
</script>

<template>
  <!-- 폴더는 약어가 아니라 모양이다. macOS 파인더의 파란 폴더 자리 -->
  <svg v-if="folder" class="fi-folder" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M1.5 4.5c0-.8.7-1.5 1.5-1.5h3.2l1.6 1.6H13c.8 0 1.5.7 1.5 1.5v5.4c0 .8-.7 1.5-1.5 1.5H3c-.8 0-1.5-.7-1.5-1.5V4.5z"
      fill="currentColor"
    />
  </svg>
  <span v-else class="fi" :class="[`t-${icon.tone}`, { small: icon.label.length > 2 }]">
    {{ icon.label }}
  </span>
</template>

<style scoped>
.fi {
  flex: none;
  width: 16px;
  height: 15px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 7.5px;
  font-weight: 700;
  /* 배경은 글자색에서 만든다 — tone 하나에 변수 하나면 된다 */
  background: color-mix(in srgb, currentColor 15%, transparent);
}
.fi.small {
  font-size: 6.5px;
  letter-spacing: -0.02em;
}

.fi-folder {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--icon-folder);
}

.t-yellow {
  color: var(--icon-yellow);
}
.t-orange {
  color: var(--icon-orange);
}
.t-red {
  color: var(--icon-red);
}
.t-pink {
  color: var(--icon-pink);
}
.t-purple {
  color: var(--icon-purple);
}
.t-indigo {
  color: var(--icon-indigo);
}
.t-blue {
  color: var(--icon-blue);
}
.t-teal {
  color: var(--icon-teal);
}
.t-mint {
  color: var(--icon-mint);
}
.t-green {
  color: var(--icon-green);
}
.t-brown {
  color: var(--icon-brown);
}
.t-gray {
  color: var(--icon-gray);
}
</style>

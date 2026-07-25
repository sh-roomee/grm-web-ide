<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  // { kind, mime, before: bytes|null, after: bytes|null }
  preview: { type: Object, required: true },
  beforeUrl: { type: String, default: '' },
  afterUrl: { type: String, default: '' },
  // 파일 하나를 그냥 볼 때(⌘P)는 '이후'만 있다
  single: { type: Boolean, default: false },
})

/** 이미지가 실제로 로드된 뒤에야 알 수 있는 것 — 픽셀 크기. */
const dims = ref({ before: null, after: null })
const failed = ref({ before: false, after: false })

// 파일이 바뀌면 이전 파일의 크기가 남아 있으면 안 된다
watch(
  () => [props.beforeUrl, props.afterUrl],
  () => {
    dims.value = { before: null, after: null }
    failed.value = { before: false, after: false }
  },
)

function onLoad(side, event) {
  const img = event.target
  dims.value = { ...dims.value, [side]: { w: img.naturalWidth, h: img.naturalHeight } }
}

function onError(side) {
  failed.value = { ...failed.value, [side]: true }
}

const panes = computed(() => {
  const list = []
  if (!props.single && props.preview.before !== null && props.beforeUrl) {
    list.push({ side: 'before', label: '이전', url: props.beforeUrl, bytes: props.preview.before })
  }
  if (props.preview.after !== null && props.afterUrl) {
    list.push({
      side: 'after',
      label: props.single ? '' : '이후',
      url: props.afterUrl,
      bytes: props.preview.after,
    })
  }
  return list
})

/** 한쪽만 있으면 추가/삭제다. 그 사실을 말로 알려준다. */
const onlyNote = computed(() => {
  if (props.single || panes.value.length !== 1) return ''
  return panes.value[0].side === 'after' ? '새로 추가된 파일' : '지워진 파일'
})

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/**
 * 용량 변화. diff 텍스트로는 절대 보이지 않는 정보라 눈에 띄게 알린다.
 * 에셋이 조용히 10배가 되는 일은 실제로 자주 일어난다.
 */
const sizeDelta = computed(() => {
  const { before, after } = props.preview
  if (typeof before !== 'number' || typeof after !== 'number' || !before) return null
  const ratio = after / before
  if (Math.abs(ratio - 1) < 0.02) return null
  // 커질 때는 퍼센트가 금방 읽을 수 없는 수가 된다(+32731%) — 배수로 쓴다.
  // 줄어들 때는 퍼센트가 −99%를 넘지 않으니 그대로 둔다.
  const text =
    ratio >= 4
      ? `×${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}`
      : `${ratio > 1 ? '+' : '−'}${Math.abs(Math.round((ratio - 1) * 100))}%`
  return { text, grew: ratio > 1, heavy: ratio >= 2 || ratio <= 0.5 }
})

/** 픽셀 크기가 달라졌으면 알린다 — 레이아웃이 깨지는 원인이 된다. */
const dimChange = computed(() => {
  const { before, after } = dims.value
  if (!before || !after) return null
  if (before.w === after.w && before.h === after.h) return null
  return `${before.w}×${before.h} → ${after.w}×${after.h}`
})

const actual = ref(false) // 실제 크기 보기
</script>

<template>
  <div class="preview">
    <header class="head">
      <span class="kind">{{ preview.mime }}</span>
      <span v-if="onlyNote" class="note">{{ onlyNote }}</span>
      <span v-if="dimChange" class="chip warn" title="픽셀 크기가 달라졌다">
        {{ dimChange }}
      </span>
      <span
        v-if="sizeDelta"
        class="chip"
        :class="{ grew: sizeDelta.grew, heavy: sizeDelta.heavy }"
        title="용량 변화"
      >
        {{ formatBytes(preview.before) }} → {{ formatBytes(preview.after) }}
        <strong>{{ sizeDelta.text }}</strong>
      </span>
      <span class="spacer" />
      <button class="ctl" :class="{ on: actual }" title="맞춰 보기 / 실제 크기" @click="actual = !actual">
        실제 크기
      </button>
    </header>

    <div class="panes" :class="{ one: panes.length === 1 }">
      <figure v-for="pane in panes" :key="pane.side" class="pane">
        <div class="frame" :class="{ actual }">
          <p v-if="failed[pane.side]" class="fail">이미지를 열 수 없습니다.</p>
          <img
            v-else
            :src="pane.url"
            :alt="`${pane.label || '파일'} 미리보기`"
            @load="onLoad(pane.side, $event)"
            @error="onError(pane.side)"
          />
        </div>
        <figcaption>
          <span v-if="pane.label" class="side" :class="pane.side">{{ pane.label }}</span>
          <span class="meta">
            <template v-if="dims[pane.side]">
              {{ dims[pane.side].w }}×{{ dims[pane.side].h }} ·
            </template>
            {{ formatBytes(pane.bytes) }}
          </span>
        </figcaption>
      </figure>
    </div>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  font-family: var(--ui);
  font-size: 12.5px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-bottom: 0.5px solid var(--border);
  flex: none;
}
.kind {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg-faint);
}
.note {
  color: var(--fg-dim);
}
.spacer {
  flex: 1;
}

.chip {
  padding: 1px 9px;
  border-radius: var(--r-pill);
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-dim);
  font-size: 11.5px;
  white-space: nowrap;
}
.chip strong {
  font-weight: 590;
  color: var(--fg);
}
/* 커진 쪽만 경고로 읽히게 한다. 줄어든 것은 좋은 소식이다 */
.chip.grew.heavy {
  background: rgba(255, 159, 10, 0.18);
  color: var(--status-conflicted);
}
.chip.grew.heavy strong {
  color: var(--status-conflicted);
}
.chip.warn {
  background: rgba(255, 159, 10, 0.18);
  color: var(--status-conflicted);
}

.ctl {
  flex: none;
  padding: 2px 10px;
  border-radius: var(--r-pill);
  color: var(--fg-dim);
  font-size: 11.5px;
}
.ctl:hover {
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg);
}
.ctl.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.panes {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  /* 체크무늬 위에서 옅은 선은 보이지 않는다. 두 판을 확실히 갈라 놓는다 */
  gap: 1px;
  background: var(--border-strong);
  overflow: auto;
}
.panes.one {
  grid-template-columns: 1fr;
}

.pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
  background: var(--bg);
}

/**
 * 투명한 부분이 보이도록 체크무늬를 깐다. 단색 배경 위에 놓으면 "투명"과
 * "그 색으로 칠해짐"을 구분할 수 없다.
 */
.frame {
  flex: 1;
  min-height: 220px;
  display: grid;
  place-items: center;
  padding: 18px;
  overflow: auto;
  background-color: #2c2c2e;
  background-image:
    linear-gradient(45deg, rgba(255, 255, 255, 0.045) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255, 255, 255, 0.045) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255, 255, 255, 0.045) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255, 255, 255, 0.045) 75%);
  background-size: 16px 16px;
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
}
.frame img {
  max-width: 100%;
  max-height: 100%;
  /* 픽셀 그림을 확대할 때 뭉개지지 않게. 아이콘 리뷰에서 이게 중요하다 */
  image-rendering: -webkit-optimize-contrast;
}
.frame.actual {
  place-items: start;
}
.frame.actual img {
  max-width: none;
  max-height: none;
}

.fail {
  margin: 0;
  color: var(--fg-faint);
}

figcaption {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-top: 0.5px solid var(--border);
  flex: none;
}
.side {
  padding: 0 8px;
  border-radius: var(--r-pill);
  font-size: 10.5px;
  font-weight: 590;
  line-height: 16px;
}
.side.before {
  background: rgba(255, 69, 58, 0.18);
  color: var(--status-deleted);
}
.side.after {
  background: rgba(48, 209, 88, 0.2);
  color: var(--status-added);
}
.meta {
  color: var(--fg-faint);
  font-family: var(--mono);
  font-size: 11px;
}
</style>

<script setup>
defineProps({
  open: { type: Boolean, default: false },
  text: { type: String, default: '' },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'copy'])
</script>

<template>
  <div v-if="open" class="backdrop" @click="emit('close')">
    <section class="sheet" @click.stop>
      <header class="head">
        <h2>사이클 요약</h2>
        <span class="counts">다음 지시에 붙여 넣는다</span>
        <span class="spacer" />
        <button class="ghost" title="닫기 (Esc)" @click="emit('close')">✕</button>
      </header>

      <div class="body">
        <p v-if="loading" class="empty">만드는 중…</p>
        <!-- 보내기 전에 사람이 읽는다. 그래서 복사만 하지 않고 보여준다 -->
        <pre v-else class="text">{{ text }}</pre>
      </div>

      <footer class="foot">
        <span class="note">코드가 무엇을 하는지는 적지 않는다 — 그건 AI가 안다</span>
        <span class="spacer" />
        <button class="send" :disabled="loading || !text" @click="emit('copy')">복사</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 60px 20px 40px;
}

.sheet {
  width: min(720px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-sheet);
  backdrop-filter: saturate(180%) blur(30px);
  -webkit-backdrop-filter: saturate(180%) blur(30px);
  border: 0.5px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-sheet);
  overflow: hidden;
  animation: rise 220ms var(--ease);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.99);
  }
}

.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px 10px;
  flex: none;
}
h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.counts {
  color: var(--fg-faint);
  font-size: 12px;
}
.spacer {
  flex: 1;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 14px 14px;
}
.empty {
  padding: 12px 2px;
  color: var(--fg-faint);
}
.text {
  margin: 0;
  padding: 14px 16px;
  background: var(--bg);
  border-radius: var(--r-md);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--fg-dim);
}

.ghost {
  color: var(--fg-faint);
  font-size: 11px;
  padding: 2px 5px;
  border-radius: var(--r-sm);
}
.ghost:hover {
  background: rgba(118, 118, 128, 0.28);
  color: var(--fg);
}

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border-top: 0.5px solid var(--border);
  flex: none;
}
.note {
  color: var(--fg-faint);
  font-size: 11px;
}

.send {
  padding: 5px 15px;
  border-radius: var(--r-pill);
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 590;
}
.send:hover {
  background: #3d9bff;
}
.send:disabled {
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-faint);
  cursor: default;
}
</style>

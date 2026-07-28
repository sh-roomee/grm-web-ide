<script setup>
/**
 * 인라인 노드를 그린다. 자기 자신을 재귀 호출한다 (`**굵게 안의 `코드`**`).
 *
 * `v-html`이 없다. 파서가 트리를 주고 Vue가 텍스트 노드로 그리므로 문서에 들어 있는
 * `<script>`는 글자로 남는다 — 막는 코드가 아니라 구조가 막는다.
 */
import { ref } from 'vue'

defineProps({
  nodes: { type: Array, required: true },
  ctx: { type: Object, required: true },
})

/**
 * 못 받아 온 그림.
 *
 * 저장소 안 경로라도 그 버전에는 없을 수 있다 — 지워졌거나 이름이 바뀌었거나, 옛
 * 커밋을 보고 있을 때다. 그냥 두면 브라우저 기본 "깨진 그림" 아이콘이 뜨는데, 그건
 * 도구가 고장난 것처럼 보인다. 저장소 밖 그림과 같은 표시로 바꿔 무엇이었는지 말한다.
 */
const failed = ref(new Set())
const markFailed = (src) => {
  failed.value = new Set(failed.value).add(src)
}
</script>

<template>
  <template v-for="(node, i) in nodes" :key="i">
    <template v-if="node.type === 'text'">{{ node.value }}</template>

    <code v-else-if="node.type === 'code'" class="md-code">{{ node.value }}</code>

    <strong v-else-if="node.type === 'strong'"><MdInline :nodes="node.children" :ctx="ctx" /></strong>

    <em v-else-if="node.type === 'em'"><MdInline :nodes="node.children" :ctx="ctx" /></em>

    <del v-else-if="node.type === 'strike'"><MdInline :nodes="node.children" :ctx="ctx" /></del>

    <br v-else-if="node.type === 'break'" />

    <!-- 저장소 안의 그림만 불러온다. 바깥 주소는 링크로 남긴다 (links.js 참고) -->
    <template v-else-if="node.type === 'image'">
      <img
        v-if="ctx.imageUrl(node.src) && !failed.has(node.src)"
        class="md-img"
        :src="ctx.imageUrl(node.src)"
        :alt="node.alt"
        loading="lazy"
        @error="markFailed(node.src)"
      />
      <span v-else class="md-img-out" :title="node.src">🖼 {{ node.alt || node.src }}</span>
    </template>

    <template v-else-if="node.type === 'link'">
      <!-- 저장소 안 문서는 이 도구의 탭으로 연다 -->
      <a
        v-if="ctx.linkOf(node.href)?.kind === 'file'"
        class="md-link"
        href="#"
        :title="ctx.linkOf(node.href).path"
        @click.prevent="ctx.openLink(node.href)"
      >
        <MdInline :nodes="node.children" :ctx="ctx" />
      </a>
      <!-- 바깥 주소는 새 브라우저 탭. referrer를 붙여 보내지 않는다 -->
      <a
        v-else-if="ctx.linkOf(node.href)?.kind === 'external'"
        class="md-link out"
        :href="node.href"
        target="_blank"
        rel="noreferrer noopener"
      >
        <MdInline :nodes="node.children" :ctx="ctx" />
      </a>
      <!-- 문서 안 앵커. 아직 이동은 하지 않아 링크로 그리지 않는다 -->
      <span v-else class="md-anchor"><MdInline :nodes="node.children" :ctx="ctx" /></span>
    </template>
  </template>
</template>

<script setup>
import { computed } from 'vue'

import MdInline from './MdInline.vue'
import { highlightLine } from '../highlight/index.js'
import { fenceLanguage } from '../markdown/links.js'

/**
 * 블록을 그린다. 인용과 목록 항목 안에서 자기 자신을 재귀 호출한다.
 *
 * 코드 펜스는 diff와 **같은 강조기**를 쓴다. 마크다운 전용 강조를 따로 만들면
 * ```java 가 뷰어에서 보던 색과 달라진다.
 */
const props = defineProps({
  blocks: { type: Array, required: true },
  ctx: { type: Object, required: true },
})

/**
 * 펜스 안을 한 줄씩 강조한다.
 *
 * 줄 단위로 도는 이유: 플러그인 규약이 한 줄을 받는다(`tokenize(line, ...)`).
 * 여러 줄 주석 같은 것은 여기서도 같은 한계를 갖지만, 뷰어와 정확히 같은 결과가
 * 나오는 편이 낫다.
 */
const fences = computed(() => {
  const map = new Map()
  props.blocks.forEach((block, i) => {
    if (block.type !== 'code') return
    const lang = fenceLanguage(block.lang)
    const lines = block.code.split('\n').map((line, idx) => ({
      key: idx,
      spans: highlightLine(lang, line, null, { lineNo: idx + 1, sections: null }),
    }))
    map.set(i, { lang, lines })
  })
  return map
})
</script>

<template>
  <template v-for="(block, i) in blocks" :key="i">
    <h1 v-if="block.type === 'heading' && block.level === 1" :id="block.id"><MdInline :nodes="block.inline" :ctx="ctx" /></h1>
    <h2 v-else-if="block.type === 'heading' && block.level === 2" :id="block.id"><MdInline :nodes="block.inline" :ctx="ctx" /></h2>
    <h3 v-else-if="block.type === 'heading' && block.level === 3" :id="block.id"><MdInline :nodes="block.inline" :ctx="ctx" /></h3>
    <h4 v-else-if="block.type === 'heading' && block.level === 4" :id="block.id"><MdInline :nodes="block.inline" :ctx="ctx" /></h4>
    <h5 v-else-if="block.type === 'heading' && block.level === 5" :id="block.id"><MdInline :nodes="block.inline" :ctx="ctx" /></h5>
    <h6 v-else-if="block.type === 'heading'" :id="block.id"><MdInline :nodes="block.inline" :ctx="ctx" /></h6>

    <p v-else-if="block.type === 'paragraph'"><MdInline :nodes="block.inline" :ctx="ctx" /></p>

    <hr v-else-if="block.type === 'hr'" />

    <pre v-else-if="block.type === 'code'" class="md-fence"><code><span
      v-for="line in fences.get(i).lines"
      :key="line.key"
      class="md-fence-line"
    ><span
      v-for="(span, s) in line.spans"
      :key="s"
      :class="span.cls && `tk-${span.cls}`"
    >{{ span.text }}</span><span v-if="!line.spans.length">&#8203;</span>
</span></code></pre>

    <blockquote v-else-if="block.type === 'quote'">
      <MdBlocks :blocks="block.blocks" :ctx="ctx" />
    </blockquote>

    <ol v-else-if="block.type === 'list' && block.ordered" :start="block.start ?? 1">
      <li v-for="(item, k) in block.items" :key="k"><MdBlocks :blocks="item.blocks" :ctx="ctx" /></li>
    </ol>

    <ul v-else-if="block.type === 'list'">
      <li
        v-for="(item, k) in block.items"
        :key="k"
        :class="{ task: item.checked !== null, done: item.checked }"
      >
        <!-- 읽기 전용 도구라 누를 수 없다. 상태를 바꾸는 일은 AI에게 시킨다 -->
        <span v-if="item.checked !== null" class="md-check" aria-hidden="true">{{
          item.checked ? '✓' : ''
        }}</span>
        <MdBlocks :blocks="item.blocks" :ctx="ctx" />
      </li>
    </ul>

    <!-- 표는 넓어질 수 있어 자기 안에서만 좌우로 스크롤한다 -->
    <div v-else-if="block.type === 'table'" class="md-table-wrap">
      <table>
        <thead>
          <tr>
            <th v-for="(cell, c) in block.head" :key="c" :style="{ textAlign: block.align[c] || undefined }">
              <MdInline :nodes="cell" :ctx="ctx" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, r) in block.rows" :key="r">
            <td v-for="(cell, c) in row" :key="c" :style="{ textAlign: block.align[c] || undefined }">
              <MdInline :nodes="cell" :ctx="ctx" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>

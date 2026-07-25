import markup from './markup.js'
import javascript from './javascript.js'
import css from './css.js'
import json from './json.js'

const BY_ID = { markup, javascript, css, json }

/**
 * Vue SFC. 한 파일에 세 언어가 섞여 있으므로 줄 번호로 구획을 찾아 넘긴다.
 *
 * 구획 정보(`sections`)는 서버가 파일 전체를 훑어 만들어 준다. diff는 파일의
 * 조각만 담고 있어서 화면에 있는 내용만으로는 `@@ -249,7 @@` 짜리 훅이
 * `<script>` 안인지 알 수 없기 때문이다.
 *
 * 구획 정보가 없으면(삭제된 파일 등) 템플릿으로 취급한다.
 */
function tokenize(line, start, end, ctx = {}) {
  const plugin = resolveSection(ctx.sections, ctx.lineNo)
  return plugin.tokenize(line, start, end, ctx)
}

function resolveSection(sections, lineNo) {
  if (!sections?.length || !lineNo) return markup
  const hit = sections.find((s) => lineNo >= s.start && lineNo <= s.end)
  if (!hit) return markup
  // 블록의 여닫는 태그 줄 자체는 마크업이다 (`<script lang="ts">`)
  if (lineNo === hit.start || lineNo === hit.end) return markup
  return BY_ID[hit.lang] ?? markup
}

export default { id: 'vue', tokenize }

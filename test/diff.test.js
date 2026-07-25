import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseUnifiedDiff } from '../server/diff.js'

const SAMPLE = `diff --git a/AudioTest.vue b/AudioTest.vue
index aa34a93..bb12cd4 100644
--- a/AudioTest.vue
+++ b/AudioTest.vue
@@ -83,7 +83,7 @@ export default {
 <script>
-import {grmNoiseCancel} from "@/lib/gooroomee/noisecancel/GrmNoiseCancel"
+import {getNoiseCancel} from "@/lib/gooroomee/noisecancel/noiseCancel"

 export default {
`

test('컨텍스트/변경 행을 side-by-side 행으로 만든다', () => {
  const result = parseUnifiedDiff(SAMPLE)
  assert.equal(result.hunks.length, 1)
  assert.equal(result.changes, 1)

  const rows = result.hunks[0].rows
  const mod = rows.find((r) => r.type === 'mod')
  assert.ok(mod, '삭제 1줄 + 추가 1줄은 하나의 mod 행으로 짝지어져야 한다')
  assert.equal(mod.left.num, 84)
  assert.equal(mod.right.num, 84)
})

test('바뀐 구간만 오프셋으로 표시한다', () => {
  const { hunks } = parseUnifiedDiff(SAMPLE)
  const mod = hunks[0].rows.find((r) => r.type === 'mod')

  const slice = (side) => side.words.map(([s, e]) => side.text.slice(s, e))
  assert.ok(slice(mod.left).some((t) => t.includes('grmNoiseCancel')))
  assert.ok(slice(mod.right).some((t) => t.includes('getNoiseCancel')))

  // 공통 부분("import {")은 변경 구간에 들어가지 않아야 한다
  const covered = (side, index) => side.words.some(([s, e]) => index >= s && index < e)
  assert.equal(covered(mod.left, 0), false)
  assert.equal(covered(mod.right, 0), false)
})

test('변경 구간 오프셋은 정렬되고 겹치지 않는다', () => {
  const raw = `--- a/x
+++ b/x
@@ -1 +1 @@
-const a = foo(1, 2) + bar
+const a = foo(9, 2) - baz
`
  const { hunks } = parseUnifiedDiff(raw)
  const mod = hunks[0].rows.find((r) => r.type === 'mod')
  for (const side of [mod.left, mod.right]) {
    let prevEnd = -1
    for (const [s, e] of side.words) {
      assert.ok(s < e, '구간은 비어 있지 않다')
      assert.ok(s > prevEnd, '구간은 정렬되고 겹치지 않는다')
      assert.ok(e <= side.text.length, '구간은 줄 길이를 넘지 않는다')
      prevEnd = e
    }
  }
})

test('행 개수가 안 맞으면 한쪽만 있는 행이 된다', () => {
  const raw = `--- a/x
+++ b/x
@@ -1,2 +1,4 @@
 a
+b
+c
+d
`
  const { hunks } = parseUnifiedDiff(raw)
  const rows = hunks[0].rows
  assert.equal(rows[0].type, 'context')
  assert.deepEqual(
    rows.slice(1).map((r) => [r.type, r.left, r.right.text]),
    [
      ['add', null, 'b'],
      ['add', null, 'c'],
      ['add', null, 'd'],
    ],
  )
})

test('빈 diff와 바이너리 diff를 구분한다', () => {
  assert.equal(parseUnifiedDiff('').hunks.length, 0)
  const bin = parseUnifiedDiff('Binary files a/logo.png and b/logo.png differ\n')
  assert.equal(bin.binary, true)
})

test('삭제된 행 번호와 추가된 행 번호가 각각 증가한다', () => {
  const raw = `--- a/x
+++ b/x
@@ -10,3 +20,3 @@
 keep
-old
+new
`
  const { hunks } = parseUnifiedDiff(raw)
  const [ctx, mod] = hunks[0].rows
  assert.equal(ctx.left.num, 10)
  assert.equal(ctx.right.num, 20)
  assert.equal(mod.left.num, 11)
  assert.equal(mod.right.num, 21)
})

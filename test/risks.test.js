import assert from 'node:assert/strict'
import { test } from 'node:test'

import { splitDiffFiles, analyzeFile, analyzeRisks } from '../server/risks.js'

const kinds = (risks) => risks.map((r) => r.kind)

test('splitDiffFiles: 여러 파일을 추가/삭제 줄로 쪼갠다', () => {
  const raw = [
    'diff --git a/src/a.js b/src/a.js',
    'index 111..222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1 @@',
    '-const old = 1',
    '+const next = 2',
    'diff --git a/src/b.js b/src/b.js',
    '--- a/src/b.js',
    '+++ b/src/b.js',
    '@@ -0,0 +1 @@',
    '+added only',
  ].join('\n')

  const files = splitDiffFiles(raw)
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed]),
    [
      ['src/a.js', ['const next = 2'], ['const old = 1']],
      ['src/b.js', ['added only'], []],
    ],
  )
})

test('splitDiffFiles: 경로에 공백이 있어도 잘라낸다', () => {
  const raw = ['diff --git a/my dir/x.js b/my dir/x.js', '@@ -1 +1 @@', '+ok'].join('\n')
  assert.equal(splitDiffFiles(raw)[0].path, 'my dir/x.js')
})

test('splitDiffFiles: 바이너리 파일을 표시한다', () => {
  const raw = [
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n')
  assert.equal(splitDiffFiles(raw)[0].binary, true)
})

test('splitDiffFiles: 빈 입력', () => {
  assert.deepEqual(splitDiffFiles(''), [])
  assert.deepEqual(splitDiffFiles(null), [])
})

test('삭제된 테스트를 잡는다 (테스트 파일에서만)', () => {
  const removed = ["  it('노이즈를 제거한다', () => {", '    assert.equal(a, b)']
  assert.deepEqual(kinds(analyzeFile({ path: 'test/a.test.js', removed })), ['test-removed'])
  // 일반 코드의 describe/it 은 다른 뜻일 수 있어 세지 않는다
  assert.deepEqual(analyzeFile({ path: 'src/a.js', removed }), [])
})

test('사라진 에러 처리를 잡는다', () => {
  const risks = analyzeFile({
    path: 'src/a.js',
    removed: ['  try {', '  } catch (err) {', '    throw err'],
    added: ['  doThing()'],
  })
  assert.deepEqual(kinds(risks), ['error-handling-removed'])
  assert.equal(risks[0].count, 3)
})

test('에러 처리가 그대로 옮겨졌으면 잡지 않는다', () => {
  const risks = analyzeFile({
    path: 'src/a.js',
    removed: ['  } catch (err) {'],
    added: ['  } catch (err) {', '  // 위치만 옮겼다'],
  })
  assert.deepEqual(risks, [], '추가된 쪽에 같은 모양이 있으면 옮긴 것으로 본다')
})

test('남겨진 디버그 출력을 잡는다 (추가된 쪽만)', () => {
  const risks = analyzeFile({
    path: 'src/a.js',
    added: ['  console.log("여기", value)', '  debugger'],
    removed: ['  console.log("지워진 것은 문제가 아니다")'],
  })
  assert.deepEqual(kinds(risks), ['debug-added'])
  assert.equal(risks[0].count, 2)
})

test('테스트 파일의 디버그 출력은 위험으로 보지 않는다', () => {
  const added = ['  console.log("검사 대상", value)']
  assert.deepEqual(analyzeFile({ path: 'src/a.js', added }), [
    { kind: 'debug-added', label: '남은 디버그 출력', count: 1, samples: ['console.log("검사 대상", value)'] },
  ])
  assert.deepEqual(analyzeFile({ path: 'test/a.test.js', added }), [])
})

test('console.error는 디버그 출력으로 보지 않는다', () => {
  assert.deepEqual(analyzeFile({ path: 'a.js', added: ['  console.error("실패", err)'] }), [])
})

test('의존성 변경을 표시한다', () => {
  const risks = analyzeFile({
    path: 'package.json',
    removed: ['    "express": "^4.19.0",'],
    added: ['    "express": "^5.0.0",'],
  })
  assert.deepEqual(kinds(risks), ['dependency'])
  assert.equal(risks[0].count, 2)
})

test('lock 파일은 내용이 안 잡혀도 변경 사실을 알린다', () => {
  const risks = analyzeFile({ path: 'package-lock.json', added: ['  "x": 1'], removed: [] })
  assert.ok(kinds(risks).includes('dependency'))
})

test('크게 지워진 파일을 표시한다', () => {
  const removed = Array.from({ length: 40 }, (_, i) => `old line ${i}`)
  const risks = analyzeFile({ path: 'src/a.js', removed, added: ['one line'] })
  assert.ok(kinds(risks).includes('large-deletion'))
  assert.match(risks.find((r) => r.kind === 'large-deletion').samples[0], /−40줄 \/ \+1줄/)
})

test('추가와 삭제가 비슷하면 크게 지워진 것으로 보지 않는다', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const risks = analyzeFile({ path: 'src/a.js', removed: lines, added: lines })
  assert.ok(!kinds(risks).includes('large-deletion'), '옮기거나 고친 것은 위험이 아니다')
})

test('바이너리 파일은 보지 않는다', () => {
  assert.deepEqual(analyzeFile({ path: 'logo.png', binary: true, added: ['x'] }), [])
})

test('예시는 세 개까지, 앞뒤 공백은 걷는다', () => {
  const added = Array.from({ length: 9 }, (_, i) => `    console.log(${i})    `)
  const [risk] = analyzeFile({ path: 'a.js', added })
  assert.equal(risk.count, 9, '개수는 전부 센다')
  assert.equal(risk.samples.length, 3, '예시는 세 개')
  assert.equal(risk.samples[0], 'console.log(0)')
})

test('analyzeRisks: 위험 없는 파일은 결과에 넣지 않는다', () => {
  const out = analyzeRisks([
    { path: 'clean.js', added: ['const a = 1'], removed: [] },
    { path: 'noisy.js', added: ['console.log(1)'], removed: [] },
  ])
  assert.deepEqual(Object.keys(out.files), ['noisy.js'])
  assert.equal(out.fileCount, 1)
  assert.equal(out.total, 1)
})

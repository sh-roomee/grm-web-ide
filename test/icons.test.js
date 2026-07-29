import { test } from 'node:test'
import assert from 'node:assert/strict'

import { iconFor, registerExt, registerName } from '../web/src/icons/index.js'

test('확장자로 찾는다 — 경로와 대소문자는 상관없다', () => {
  assert.deepEqual(iconFor('web/src/App.vue'), { label: 'V', tone: 'green' })
  assert.deepEqual(iconFor('SERVER/INDEX.JS'), { label: 'JS', tone: 'yellow' })
  assert.deepEqual(iconFor('docs/API.md'), { label: 'MD', tone: 'blue' })
})

test('파일명이 확장자보다 먼저다', () => {
  assert.deepEqual(iconFor('package.json'), { label: 'npm', tone: 'red' })
  assert.deepEqual(iconFor('a/b/package-lock.json'), { label: 'LK', tone: 'gray' })
  assert.deepEqual(iconFor('.gitignore'), { label: 'git', tone: 'orange' })
  // 파일명 표에 없는 json은 확장자로 떨어진다
  assert.deepEqual(iconFor('src/manifest.json'), { label: '{}', tone: 'yellow' })
})

test('확장자 없는 설정 파일도 아이콘이 있다', () => {
  // 없으면 전부 회색 점이 되어 목록에서 구분이 안 된다
  assert.equal(iconFor('.prettierrc').label, 'PR')
  assert.equal(iconFor('web/.eslintrc').label, 'ES')
  assert.equal(iconFor('Jenkinsfile').label, 'JK')
  assert.equal(iconFor('.npmrc').label, 'npm')
  assert.equal(iconFor('tsconfig.json').label, 'TS') // 이름이 확장자보다 먼저
})

test('.env는 변형(.env.local 등)까지 잡는다', () => {
  assert.equal(iconFor('.env').label, 'ENV')
  assert.equal(iconFor('.env.production').label, 'ENV')
})

test('테스트 파일은 언어 약어에 초록을 입힌다', () => {
  assert.deepEqual(iconFor('test/icons.test.js'), { label: 'JS', tone: 'green' })
  assert.deepEqual(iconFor('src/a.spec.ts'), { label: 'TS', tone: 'green' })
})

test('모르는 확장자는 약어를 만들어 회색으로', () => {
  assert.deepEqual(iconFor('data.parquet'), { label: 'PAR', tone: 'gray' })
})

test('확장자가 없으면 기본 아이콘 — 숨김 파일의 앞 점은 확장자가 아니다', () => {
  assert.deepEqual(iconFor('bin/grmide'), { label: '·', tone: 'gray' })
  assert.deepEqual(iconFor('.myrc'), { label: '·', tone: 'gray' })
})

test('밖에서 등록해 늘릴 수 있다 (플러그인)', () => {
  registerExt('zig', { label: 'ZG', tone: 'orange' })
  registerName('justfile', { label: 'JF', tone: 'gray' })
  assert.equal(iconFor('src/main.zig').label, 'ZG')
  assert.equal(iconFor('Justfile').label, 'JF')
})

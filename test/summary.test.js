import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderSummary } from '../bin/summary.js'

// 테스트는 TTY가 아니므로 색 코드 없이 평문이 나온다. 그래서 문자열로 검사할 수 있다.
const BASE = {
  repo: '/Users/me/work/my-project',
  branch: 'main',
  head: { shortSha: 'abc1234', subject: '이전 커밋', relativeDate: '2 hours ago' },
  url: 'http://127.0.0.1:4317/?t=deadbeef',
  dev: false,
  token: 'deadbeef',
}

const EMPTY = { staged: [], unstaged: [], conflicted: [] }

const file = (path, over = {}) => ({
  path,
  status: 'modified',
  staged: false,
  additions: 1,
  deletions: 1,
  ...over,
})

test('색 코드가 섞이지 않는다 (TTY가 아닐 때)', () => {
  const out = renderSummary({ ...BASE, status: EMPTY })
  assert.ok(!out.includes(''), 'ANSI escape가 없어야 한다')
})

test('저장소 이름 · 브랜치 · 경로 · HEAD를 보여준다', () => {
  const out = renderSummary({ ...BASE, status: EMPTY })
  assert.match(out, /grmide {2}my-project/)
  assert.match(out, /⎇ main/)
  assert.ok(out.includes('/Users/me/work/my-project'))
  assert.ok(out.includes('abc1234 이전 커밋'))
  assert.ok(out.includes('2 hours ago'))
  assert.ok(out.includes('http://127.0.0.1:4317/?t=deadbeef'))
})

test('변경이 없으면 그렇게 알린다', () => {
  const out = renderSummary({ ...BASE, status: EMPTY })
  assert.match(out, /변경.*없음/)
})

test('커밋이 없는 저장소도 처리한다', () => {
  const out = renderSummary({ ...BASE, head: null, branch: '(empty)', status: EMPTY })
  assert.match(out, /HEAD.*커밋 없음/)
})

test('파일 수는 경로 기준으로 센다 (일부만 stage된 파일은 하나)', () => {
  const status = {
    staged: [file('a.js', { staged: true, additions: 3, deletions: 0 })],
    unstaged: [file('a.js', { additions: 2, deletions: 1 }), file('b.js')],
    conflicted: [],
  }
  const out = renderSummary({ ...BASE, status })
  // a.js가 양쪽에 있지만 파일 수는 2개
  assert.match(out, /2개 파일/)
  // 줄 수는 양쪽을 합쳐서 센다
  assert.ok(out.includes('+6'))
  assert.ok(out.includes('-2'))
  assert.match(out, /staged 1/)
  assert.match(out, /unstaged 2/)
})

test('충돌 / untracked를 구분해 센다', () => {
  const status = {
    staged: [],
    unstaged: [file('new.js', { status: 'untracked', untracked: true, deletions: 0 })],
    conflicted: [file('c.js', { status: 'conflicted', additions: null, deletions: null })],
  }
  const out = renderSummary({ ...BASE, status })
  assert.match(out, /충돌 1/)
  assert.match(out, /untracked 1/)
  assert.ok(!out.includes('unstaged 1'), 'untracked를 unstaged로 이중 계산하면 안 된다')
})

test('바이너리 파일은 줄 수 대신 표시로 알린다', () => {
  const status = {
    staged: [],
    unstaged: [file('logo.png', { additions: null, deletions: null })],
    conflicted: [],
  }
  const out = renderSummary({ ...BASE, status })
  assert.ok(out.includes('바이너리'))
  assert.match(out, /바이너리 1/) // 합계 줄에는 개수가 붙는다
})

test('파일이 많으면 잘라내고 남은 개수를 알린다', () => {
  const status = {
    staged: [],
    unstaged: Array.from({ length: 10 }, (_, i) => file(`file${i}.js`)),
    conflicted: [],
  }
  const out = renderSummary({ ...BASE, status })
  assert.match(out, /10개 파일/)
  assert.match(out, /그 외 4개/) // 6개만 보여준다
  assert.ok(out.includes('file0.js'))
  assert.ok(!out.includes('file9.js'))
})

test('한글 라벨이 섞여도 값의 시작 위치가 같다', () => {
  const out = renderSummary({ ...BASE, status: EMPTY })
  const lines = out.split('\n')
  const pathLine = lines.find((l) => l.includes('/Users/me'))
  const headLine = lines.find((l) => l.includes('abc1234'))

  // 표시 폭은 둘 다 8칸이다: "경로"(2글자·4칸)+4공백, "HEAD"(4글자·4칸)+4공백.
  // 글자 수로는 6과 8로 다르지만, 터미널에서 보이는 위치는 같다.
  assert.ok(pathLine.startsWith('경로    '), '경로 뒤에 공백 4개')
  assert.ok(headLine.startsWith('HEAD    '), 'HEAD 뒤에 공백 4개')
  assert.equal(pathLine.indexOf('/Users/me'), 6)
  assert.equal(headLine.indexOf('abc1234'), 8)
})

test('긴 커밋 제목은 잘라낸다', () => {
  const long = '아주 긴 커밋 제목을 넣어서 터미널이 줄바꿈되지 않도록 잘라내는지 확인한다 그리고 더 길게'
  const out = renderSummary({ ...BASE, head: { ...BASE.head, subject: long }, status: EMPTY })
  assert.ok(out.includes('…'), '잘렸다는 표시가 있어야 한다')
  assert.ok(!out.includes('그리고 더 길게'))
})

test('dev 모드에서는 vite 주소를 함께 알린다', () => {
  const out = renderSummary({ ...BASE, status: EMPTY, dev: true })
  assert.ok(out.includes('http://localhost:5173/?t=deadbeef'))
})

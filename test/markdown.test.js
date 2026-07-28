import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseMarkdown } from '../web/src/markdown/parse.js'
import { parseInline, safeHref } from '../web/src/markdown/inline.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 트리에서 글자만 뽑는다. 구조가 아니라 "내용이 사라지지 않았는지"를 볼 때 쓴다. */
function textOf(nodes) {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'text') return n.value
      if (n.type === 'code') return n.value
      if (n.type === 'image') return `${n.alt} ${n.src}`
      if (n.type === 'break') return '\n'
      // 주소도 잃으면 안 되는 내용이다. 앵커(`#겉모습은-...`)가 깨지면 링크가 죽는다.
      const inner = textOf(n.children)
      return n.type === 'link' ? `${inner} ${n.href}` : inner
    })
    .join('')
}

function blockText(block) {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return textOf(block.inline)
    case 'code':
      return block.code
    case 'quote':
      return block.blocks.map(blockText).join('\n')
    case 'list':
      return block.items.map((it) => it.blocks.map(blockText).join('\n')).join('\n')
    case 'table':
      return [block.head, ...block.rows].map((r) => r.map(textOf).join(' ')).join('\n')
    default:
      return ''
  }
}

// --- 제목

test('ATX 제목은 단계와 내용을 나눈다', () => {
  const [h] = parseMarkdown('### 설계 결정')
  assert.equal(h.type, 'heading')
  assert.equal(h.level, 3)
  assert.equal(textOf(h.inline), '설계 결정')
})

test('닫는 #은 장식이라 내용에서 뗀다', () => {
  const [h] = parseMarkdown('## 제목 ##')
  assert.equal(textOf(h.inline), '제목')
})

test('#이 일곱 개면 제목이 아니다', () => {
  const [b] = parseMarkdown('####### 일곱')
  assert.equal(b.type, 'paragraph')
})

test('문단 다음 줄의 ===는 setext 제목이다', () => {
  const [h] = parseMarkdown('grmide\n======')
  assert.equal(h.type, 'heading')
  assert.equal(h.level, 1)
})

test('빈 줄 뒤의 ---는 제목이 아니라 구분선이다', () => {
  // README가 절 사이에 쓰는 형태다. setext로 읽으면 앞 문단이 거대한 제목이 된다.
  const blocks = parseMarkdown('앞 문단\n\n---\n\n뒤 문단')
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['paragraph', 'hr', 'paragraph'],
  )
})

// --- 코드 펜스

test('코드 펜스는 언어와 내용을 그대로 담는다', () => {
  const [c] = parseMarkdown('```java\nint a = 1;\n```')
  assert.equal(c.type, 'code')
  assert.equal(c.lang, 'java')
  assert.equal(c.code, 'int a = 1;')
})

test('코드 펜스 안은 마크다운으로 읽지 않는다', () => {
  const [c] = parseMarkdown('```\n# 제목이 아니다\n- 목록도 아니다\n*강조*도 아니다\n```')
  assert.equal(c.type, 'code')
  assert.equal(c.code, '# 제목이 아니다\n- 목록도 아니다\n*강조*도 아니다')
})

test('펜스는 여는 개수 이상으로만 닫힌다', () => {
  const [c] = parseMarkdown('````\n```\n안쪽\n```\n````')
  assert.equal(c.code, '```\n안쪽\n```')
})

test('~~~도 펜스다', () => {
  const [c] = parseMarkdown('~~~sh\nnpm test\n~~~')
  assert.equal(c.type, 'code')
  assert.equal(c.code, 'npm test')
})

test('닫히지 않은 펜스는 파일 끝까지 코드다', () => {
  // 작성 중인 파일에서 흔하다. 여기서 예외가 나면 미리보기 전체가 죽는다.
  const [c] = parseMarkdown('```js\nconst a = 1')
  assert.equal(c.type, 'code')
  assert.equal(c.code, 'const a = 1')
})

// --- 목록

test('불릿 목록은 항목마다 블록을 가진다', () => {
  const [l] = parseMarkdown('- 하나\n- 둘')
  assert.equal(l.type, 'list')
  assert.equal(l.ordered, false)
  assert.equal(l.items.length, 2)
  assert.equal(blockText(l.items[0].blocks[0]), '하나')
})

test('번호 목록은 시작 번호를 기억한다', () => {
  const [l] = parseMarkdown('3. 셋\n4. 넷')
  assert.equal(l.ordered, true)
  assert.equal(l.start, 3)
  assert.equal(l.items.length, 2)
})

test('들여쓴 목록은 항목 안에 중첩된다', () => {
  const [l] = parseMarkdown('- 겉\n  - 안1\n  - 안2\n- 겉2')
  assert.equal(l.items.length, 2)
  const nested = l.items[0].blocks.find((b) => b.type === 'list')
  assert.ok(nested, '중첩 목록이 항목 안에 있어야 한다')
  assert.equal(nested.items.length, 2)
})

test('불릿에서 번호로 바뀌면 다른 목록이다', () => {
  const blocks = parseMarkdown('- 불릿\n1. 번호')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].ordered, false)
  assert.equal(blocks[1].ordered, true)
})

test('항목에 이어 쓴 줄은 같은 항목에 붙는다', () => {
  // 이 저장소 문서가 자주 쓰는 형태다 (두 번째 줄을 6칸 들여쓴다)
  const [l] = parseMarkdown('- [x] **한 줄 보기** — 설명이 길어서\n      다음 줄로 이어진다\n- 다음 항목')
  assert.equal(l.items.length, 2)
  assert.match(blockText(l.items[0].blocks[0]), /이어진다/)
})

test('목록 항목 안의 코드 블록은 항목에 속한다', () => {
  const [l] = parseMarkdown('- 이렇게 쓴다\n\n  ```sh\n  npm test\n  ```\n\n- 다음')
  assert.equal(l.items.length, 2)
  const code = l.items[0].blocks.find((b) => b.type === 'code')
  assert.ok(code, '항목 안에 코드 블록이 있어야 한다')
  assert.equal(code.code, 'npm test')
})

test('- [x] 는 체크된 항목이다', () => {
  const [l] = parseMarkdown('- [x] 한 일\n- [ ] 안 한 일\n- 보통 항목')
  assert.deepEqual(
    l.items.map((it) => it.checked),
    [true, false, null],
  )
  // 표시는 떼고 내용만 남는다
  assert.equal(blockText(l.items[0].blocks[0]), '한 일')
  assert.equal(blockText(l.items[1].blocks[0]), '안 한 일')
})

test('대문자 X도 체크로 본다', () => {
  const [l] = parseMarkdown('- [X] 한 일')
  assert.equal(l.items[0].checked, true)
})

test('체크 항목의 이어지는 줄과 링크를 잃지 않는다', () => {
  // ROADMAP 이 쓰는 실제 형태다
  const [l] = parseMarkdown(
    '- [x] **한 줄 보기** — 설명\n      ([ARCHITECTURE](ARCHITECTURE.md#겉모습))\n- [ ] 다음',
  )
  assert.equal(l.items[0].checked, true)
  const text = l.items[0].blocks.map(blockText).join(' ')
  assert.match(text, /한 줄 보기/)
  assert.match(text, /ARCHITECTURE\.md#겉모습/)
})

test('- - - 는 목록이 아니라 구분선이다', () => {
  const [b] = parseMarkdown('- - -')
  assert.equal(b.type, 'hr')
})

// --- 인용

test('인용은 안쪽을 다시 블록으로 읽는다', () => {
  const [q] = parseMarkdown('> ## 안쪽 제목\n> 본문')
  assert.equal(q.type, 'quote')
  assert.equal(q.blocks[0].type, 'heading')
  assert.equal(q.blocks[1].type, 'paragraph')
})

// --- 표

test('표는 머리·정렬·본문으로 나뉜다', () => {
  const [t] = parseMarkdown('| 문서 | 갱신할 때 |\n| --- | :-: |\n| `API.md` | 스키마 변경 |')
  assert.equal(t.type, 'table')
  assert.deepEqual(t.align, [null, 'center'])
  assert.equal(textOf(t.head[0]), '문서')
  assert.equal(t.rows.length, 1)
  assert.equal(textOf(t.rows[0][0]), 'API.md')
})

test('정렬 표시를 읽는다', () => {
  const [t] = parseMarkdown('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')
  assert.deepEqual(t.align, ['left', 'center', 'right'])
})

test('구분선 없이는 표가 아니다', () => {
  const [b] = parseMarkdown('| 이건 | 표가 아니다 |')
  assert.equal(b.type, 'paragraph')
})

test('칸 수가 머리와 다르면 표가 아니다', () => {
  const blocks = parseMarkdown('| a | b |\n| --- |\n| 1 | 2 |')
  assert.equal(blocks[0].type, 'paragraph')
})

test('코드 스팬 안의 파이프는 칸을 나누지 않는다', () => {
  const [t] = parseMarkdown('| 키 | 뜻 |\n| --- | --- |\n| `a \\| b` | 또는 |')
  assert.equal(t.rows[0].length, 2)
  assert.equal(textOf(t.rows[0][1]), '또는')
  // 표 안에서는 코드 안에서도 `\|` 로 써야 하므로 역슬래시가 화면에 남으면 안 된다
  assert.equal(textOf(t.rows[0][0]), 'a | b')
})

// --- 인라인

test('굵게·기울임·인라인 코드', () => {
  const nodes = parseInline('**굵게** *기울임* `코드`')
  assert.deepEqual(
    nodes.filter((n) => n.type !== 'text').map((n) => n.type),
    ['strong', 'em', 'code'],
  )
})

test('인라인 코드 안의 별표는 강조가 아니다', () => {
  const nodes = parseInline('`a * b * c`')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].type, 'code')
  assert.equal(nodes[0].value, 'a * b * c')
})

test('낱말 안의 밑줄은 기울임이 아니다', () => {
  const nodes = parseInline('snake_case_name')
  assert.equal(textOf(nodes), 'snake_case_name')
  assert.ok(!nodes.some((n) => n.type === 'em'))
})

test('공백에 둘러싸인 별표는 곱셈 기호다', () => {
  const nodes = parseInline('a * b * c')
  assert.equal(textOf(nodes), 'a * b * c')
  assert.ok(!nodes.some((n) => n.type === 'em'))
})

test('링크는 주소와 라벨을 나눈다', () => {
  const [link] = parseInline('[ARCHITECTURE](docs/ARCHITECTURE.md)')
  assert.equal(link.type, 'link')
  assert.equal(link.href, 'docs/ARCHITECTURE.md')
  assert.equal(textOf(link.children), 'ARCHITECTURE')
})

test('주소 안의 괄호와 앵커를 잃지 않는다', () => {
  const [link] = parseInline('[결정](ARCHITECTURE.md#코드-표면은-캔버스보다-밝다-2026-07-27)')
  assert.equal(link.href, 'ARCHITECTURE.md#코드-표면은-캔버스보다-밝다-2026-07-27')
})

test('이미지는 alt와 주소를 나눈다', () => {
  const [img] = parseInline('![코드 보기](docs/shot.png)')
  assert.equal(img.type, 'image')
  assert.equal(img.src, 'docs/shot.png')
  assert.equal(img.alt, '코드 보기')
})

test('줄 끝 공백 두 칸은 강제 줄바꿈이다', () => {
  const nodes = parseInline('첫 줄  \n둘째 줄')
  assert.ok(nodes.some((n) => n.type === 'break'))
})

test('그냥 개행은 한 칸 공백으로 이어붙인다', () => {
  const nodes = parseInline('첫 줄\n둘째 줄')
  assert.ok(!nodes.some((n) => n.type === 'break'))
  assert.equal(textOf(nodes), '첫 줄 둘째 줄')
})

test('백슬래시로 문법을 끌 수 있다', () => {
  const nodes = parseInline('\\*굵게 아님\\*')
  assert.equal(textOf(nodes), '*굵게 아님*')
  assert.ok(!nodes.some((n) => n.type === 'em' || n.type === 'strong'))
})

// --- 주소 검사 (트리를 그리므로 태그 주입은 막히지만 href는 우리가 넣는다)

test('javascript: 주소는 링크로 만들지 않는다', () => {
  assert.equal(safeHref('javascript:alert(1)'), null)
  const nodes = parseInline('[클릭](javascript:alert(1))')
  // 링크는 버리고 글자는 남긴다 — 조용히 지우면 내용이 사라진다
  assert.ok(!nodes.some((n) => n.type === 'link'))
  assert.equal(textOf(nodes), '클릭')
})

test('data: 주소도 막는다', () => {
  assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null)
})

test('제어문자를 끼운 주소를 막는다', () => {
  assert.equal(safeHref('java\tscript:alert(1)'), null)
  assert.equal(safeHref('java\nscript:alert(1)'), null)
  assert.equal(safeHref('java script:alert(1)'), null)
})

test('평범한 주소는 통과한다', () => {
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(safeHref('docs/API.md'), 'docs/API.md')
  assert.equal(safeHref('#anchor'), '#anchor')
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c')
})

// --- 안정성

test('빈 입력과 이상한 입력에 예외를 던지지 않는다', () => {
  for (const input of ['', null, undefined, '\n\n\n', '   ', '|', '```', '>', '- ', '#']) {
    assert.doesNotThrow(() => parseMarkdown(input), `입력: ${JSON.stringify(input)}`)
  }
})

test('원시 HTML을 트리에 넣지 않는다', () => {
  // 이 파서는 트리만 내놓고 Vue가 텍스트로 그린다. 태그가 살아날 자리가 없어야 한다.
  const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img onerror="alert(1)">')
  const flat = JSON.stringify(blocks)
  assert.ok(!flat.includes('"type":"html"'), 'html 노드를 만들지 않는다')
  // 글자로는 남는다 (조용히 지우지 않는다)
  assert.match(blocks.map(blockText).join('\n'), /alert\(1\)/)
})

test('HTML 주석은 버린다', () => {
  const blocks = parseMarkdown('<!-- 안 보이는 메모 -->\n\n본문')
  assert.equal(blocks.length, 1)
  assert.equal(blockText(blocks[0]), '본문')
})

// --- 실제 문서로 확인 (이 저장소의 docs/ 가 시험지다)

const DOCS = ['README.md', 'CLAUDE.md', 'docs/ARCHITECTURE.md', 'docs/ROADMAP.md', 'docs/ONBOARDING.md', 'docs/API.md']

for (const rel of DOCS) {
  test(`${rel} 을 파싱하고 내용을 잃지 않는다`, () => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    const blocks = parseMarkdown(src)
    assert.ok(blocks.length > 5, '블록이 나와야 한다')

    // 문단이 통째로 코드 블록으로 삼켜지는 등의 사고를 잡는다:
    // 원문의 한글/영문 낱말이 결과에도 있어야 한다.
    const rendered = blocks.map(blockText).join('\n')
    const words = src.match(/[가-힣]{3,}|[A-Za-z]{5,}/g) ?? []
    const unique = [...new Set(words)]
    const missing = unique.filter((w) => !rendered.includes(w))
    assert.deepEqual(missing, [], `사라진 낱말: ${missing.slice(0, 8).join(', ')}`)
  })
}

test('제목 개수가 원문의 # 개수와 맞는다', () => {
  const src = fs.readFileSync(path.join(root, 'docs/ARCHITECTURE.md'), 'utf8')
  const blocks = parseMarkdown(src)

  // 코드 블록 안의 #은 제목이 아니므로 원문을 셀 때도 펜스를 건너뛴다
  let inFence = false
  let expected = 0
  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && /^#{1,6}\s+\S/.test(line)) expected++
  }

  const got = blocks.filter((b) => b.type === 'heading' && b.level >= 1).length
  assert.equal(got, expected)
})

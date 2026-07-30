/**
 * 나란히 보기의 행 목록을 한 줄 보기 목록으로 펼친다.
 *
 * 한 행(row)은 좌우 두 셀을 가진다. 한 줄 보기에서는 이걸 순서대로 늘어놓는다:
 *
 *   문맥 행  → 한 줄 (오른쪽 셀. 양쪽 내용이 같다)
 *   변경 행  → 삭제 줄(−) 다음에 추가 줄(+)
 *
 * `blockIndex`는 펼친 **첫 줄에만** 남긴다. 두 줄에 같은 번호가 붙으면 "다음
 * 변경으로" 이동이 같은 자리를 두 번 세고, 마커도 두 개가 겹쳐 찍힌다.
 *
 * 훅 헤더 같은 다른 항목은 그대로 통과시킨다.
 *
 * `spans`는 getter로 넘긴다. 원본 셀의 span 계산이 **접근할 때** 일어나는데
 * (DiffViewer 참고), 여기서 값으로 읽으면 펼치는 순간 파일 전체가 계산된다.
 */
export function flattenInline(items) {
  const out = []

  for (const item of items) {
    if (item.kind !== 'row') {
      out.push(item)
      continue
    }
    const { row, left, right, blockIndex, key } = item

    if (row.type === 'context') {
      out.push({
        kind: 'line',
        type: 'context',
        sign: '',
        side: 'right',
        cell: row.right,
        get spans() {
          return right?.spans
        },
        hit: right?.first ?? null,
        oldNum: row.left?.num ?? null,
        newNum: row.right?.num ?? null,
        blockIndex,
        key,
      })
      continue
    }

    let mark = blockIndex
    if (row.left) {
      out.push({
        kind: 'line',
        type: 'del',
        sign: '−',
        side: 'left',
        cell: row.left,
        get spans() {
          return left?.spans
        },
        hit: left?.first ?? null,
        oldNum: row.left.num,
        newNum: null,
        blockIndex: mark,
        key: `${key}-d`,
      })
      mark = null
    }
    if (row.right) {
      out.push({
        kind: 'line',
        type: 'add',
        sign: '+',
        side: 'right',
        cell: row.right,
        get spans() {
          return right?.spans
        },
        hit: right?.first ?? null,
        oldNum: null,
        newNum: row.right.num,
        blockIndex: mark,
        key: `${key}-a`,
      })
    }
  }

  return out
}

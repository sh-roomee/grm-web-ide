/**
 * 넘긴 코멘트가 반영됐는지 판정한다.
 *
 * 리뷰를 AI에게 넘기고 나면 다음 질문은 항상 "저거 고쳐졌나"다. 지금까지는
 * 코멘트가 계속 쌓이기만 해서 리뷰가 한 방향으로 끝났다.
 *
 * 판정 근거는 **코멘트를 달 때 함께 저장해 둔 코드 조각**이다. 줄 번호로 보지
 * 않는 이유: 위쪽이 몇 줄만 바뀌어도 번호가 밀려 엉뚱한 줄을 보게 된다. 코드
 * 조각은 밀려도 따라간다.
 *
 * 판정은 어림짐작이다. AI가 코드를 그대로 두고 "확인했고 문제 없다"고 답한
 * 경우는 알 수 없다. 그래서 화면에서도 단정하지 않고 표시만 한다.
 */

/** 줄 끝 공백과 개행 방식 차이로 "바뀌었다"고 오판하지 않게 다듬는다. */
function normalize(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim()
}

/**
 * @param comment 저장된 코멘트 { side, code, sha }
 * @param file    { text: string|null, mtime: number|null } — text가 null이면 파일이 없다
 * @returns {{ state: 'open'|'applied'|'frozen'|'unknown', reason?: string }}
 */
export function commentStatus(comment, file) {
  // 커밋에 단 코멘트는 대상이 이미 굳어 있다. 판정하지 않는다.
  if (comment?.sha) return { state: 'frozen', reason: 'commit' }

  const snippet = normalize(comment?.code ?? '')
  if (!snippet) return { state: 'unknown', reason: 'no-code' }

  if (file?.text === null || file?.text === undefined) {
    // 파일이 사라졌다 = 그 코드도 사라졌다
    return comment.side === 'left'
      ? { state: 'open', reason: 'file-gone' }
      : { state: 'applied', reason: 'file-gone' }
  }

  const present = normalize(file.text).includes(snippet)

  /**
   * 오른쪽(지금 코드)에 단 코멘트: 그 코드가 아직 있으면 안 고친 것이다.
   * 왼쪽(삭제된 코드)에 단 코멘트: 되살아나 있으면 고친 것이다. 방향이 뒤집힌다.
   */
  if (comment.side === 'left') {
    return present ? { state: 'applied', reason: 'restored' } : { state: 'open' }
  }
  return present ? { state: 'open' } : { state: 'applied', reason: 'changed' }
}

/** 코멘트 목록에 상태를 붙인다. 파일 읽기는 호출한 쪽이 한다(경로당 한 번). */
export function attachStatus(comments, files) {
  return comments.map((comment) => ({
    ...comment,
    status: {
      ...commentStatus(comment, files.get(comment.path) ?? { text: null, mtime: null }),
      // "파일이 언제 바뀌었나"는 줄 단위가 아니라 파일 단위 정보다. 그렇게 부른다.
      fileMtime: files.get(comment.path)?.mtime ?? null,
    },
  }))
}

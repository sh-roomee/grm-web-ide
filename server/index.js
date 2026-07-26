import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'

import * as gitApi from './git.js'
import { parseUnifiedDiff } from './diff.js'
import { highlightInfo } from './language.js'
import { analyzeRisks, splitDiffFiles } from './risks.js'
import { previewInfo } from './preview.js'
import { attachStatus } from './resolve.js'
import {
  normalizeItem,
  itemKey,
  buildContextPrompt,
  MAX_GREP_HITS,
} from './context.js'
import {
  readState,
  saveReviewed,
  addComment,
  updateComment,
  removeComment,
  clearComments,
  buildPrompt,
  addContext,
  removeContext,
  clearContext,
} from './state.js'
import { createWatcher } from './watcher.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIST = path.resolve(__dirname, '..', 'web', 'dist')

/**
 * 요청 경로가 저장소 안에 있는지 검증한다.
 *
 * `--no-index` diff와 파일 읽기는 git의 pathspec 보호를 받지 않으므로,
 * 로컬 서버라 해도 저장소 밖 파일이 노출되지 않도록 직접 막는다.
 */
function safeJoin(repo, relPath) {
  if (typeof relPath !== 'string' || relPath === '') {
    const err = new Error('path 파라미터가 필요합니다')
    err.status = 400
    throw err
  }
  const abs = path.resolve(repo, relPath)
  const rel = path.relative(repo, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('저장소 밖의 경로는 접근할 수 없습니다')
    err.status = 403
    throw err
  }
  return abs
}

/**
 * 커밋 해시로 쓸 수 있는 값인지 확인한다.
 *
 * git은 `--`로 인자와 경로를 나누지만 리비전 자리에는 `HEAD~3`이나 `main..x`
 * 같은 표현이 다 들어간다. 여기서는 클라이언트가 목록에서 받은 해시만 되돌려
 * 보내면 되므로 16진수로 못박는다.
 */
function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{4,40}$/i.test(value) ? value : null
}

/** 미리보기로 내보낼 수 있는 최대 크기. 이보다 크면 브라우저에 밀어넣지 않는다. */
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024

/**
 * 미리보기가 읽을 git rev를 정한다.
 *
 * rev를 클라이언트가 직접 보내게 하지 않는 이유: 그러면 임의 리비전을 읽는
 * 엔드포인트가 된다. 대신 diff를 요청할 때와 **같은 파라미터**(sha·staged·base)를
 * 받아 서버가 이전/이후를 해석한다. 화면에서 보고 있는 것과 어긋날 수 없다.
 *
 * null은 "워킹트리 파일", false는 "그 쪽은 없다"(추가/삭제된 파일)를 뜻한다.
 */
function previewRev({ side, sha, staged, base, untracked, baselineRef }) {
  if (side === 'after') {
    if (sha) return sha
    if (staged) return '' // `git show :path` = index
    return null
  }
  if (untracked) return false // 새로 생긴 파일에는 이전이 없다
  if (sha) return `${sha}^`
  if (base && baselineRef) return baselineRef
  return 'HEAD'
}

// 커밋 검색 대상. 이 목록에 없는 값은 message로 떨어진다.
const SEARCH_MODES = new Set(['message', 'author', 'content', 'path'])

function clamp(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function createServer({ repo, token, gitDir, dev = false }) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.disable('x-powered-by')

  const clients = new Set()

  // --- 인증: 로컬 바인딩이지만 같은 머신의 다른 프로세스/사이트가 붙는 것을 막는다.
  app.use('/api', (req, res, next) => {
    const provided = req.get('x-grmide-token') || req.query.t
    if (provided !== token) return res.status(401).json({ error: '토큰이 유효하지 않습니다' })
    next()
  })

  const wrap = (handler) => (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const status = err.status ?? 500
      if (status >= 500) console.error('[grmide]', err)
      res.status(status).json({ error: err.message })
    })
  }

  app.get(
    '/api/repo',
    wrap(async (_req, res) => {
      const [branch, head] = await Promise.all([gitApi.currentBranch(repo), gitApi.headCommit(repo)])
      res.json({ root: repo, name: path.basename(repo), branch, head })
    }),
  )

  app.get(
    '/api/status',
    wrap(async (_req, res) => {
      const [status, baseline] = await Promise.all([gitApi.status(repo), gitApi.getBaseline(repo)])

      // 기준점이 없으면 비교 비용을 아예 치르지 않는다
      let fresh = null
      if (baseline) {
        try {
          fresh = await gitApi.changedSinceBaseline(repo, gitDir, baseline)
        } catch (err) {
          console.error('[grmide] 기준점 비교 실패:', err.message)
        }
      }

      // 기준점 이후 바뀐 파일에 표시를 남긴다
      let freshCount = 0
      if (fresh) {
        const seen = new Set()
        for (const list of [status.conflicted, status.staged, status.unstaged]) {
          for (const file of list) {
            file.fresh = fresh.has(file.path)
            if (file.fresh && !seen.has(file.path)) {
              seen.add(file.path)
              freshCount += 1
            }
          }
        }
      }

      res.json({ ...status, baseline: baseline ? { tree: baseline, freshCount } : null })
    }),
  )

  app.post(
    '/api/baseline',
    wrap(async (_req, res) => {
      res.json({ tree: await gitApi.setBaseline(repo, gitDir) })
    }),
  )

  app.delete(
    '/api/baseline',
    wrap(async (_req, res) => {
      await gitApi.clearBaseline(repo)
      res.json({ ok: true })
    }),
  )

  app.get(
    '/api/diff',
    wrap(async (req, res) => {
      const relPath = req.query.path
      safeJoin(repo, relPath)
      const staged = req.query.staged === '1' || req.query.staged === 'true'
      const untracked = req.query.untracked === '1' || req.query.untracked === 'true'
      const context = Number.parseInt(req.query.context ?? '3', 10)
      const sha = validSha(req.query.sha)
      // base=1 이면 HEAD가 아니라 기준점(마지막으로 확인한 시점) 대비로 본다
      const base = req.query.base === '1' || req.query.base === 'true'

      const [raw, highlight] = await Promise.all([
        sha
          ? gitApi.commitFileDiff(repo, sha, relPath, { context })
          : base
            ? gitApi.baselineFileDiff(repo, gitDir, relPath, { context })
            : gitApi.fileDiff(repo, relPath, { staged, untracked, context }),
        highlightInfo(repo, relPath),
      ])
      const parsed = parseUnifiedDiff(raw)

      // 그림으로 볼 수 있는 파일이면 양쪽 크기를 함께 준다. "이 이미지가 갑자기
      // 커졌나"는 diff 텍스트로는 절대 보이지 않는 정보다.
      const info = previewInfo(relPath)
      let preview = null
      if (info) {
        const baselineRef = base ? gitApi.baselineRef() : null
        const revs = {
          before: previewRev({ side: 'before', sha, staged, base, untracked, baselineRef }),
          after: previewRev({ side: 'after', sha, staged, base, untracked, baselineRef }),
        }
        const [before, after] = await Promise.all([
          revs.before === false ? null : gitApi.blobSize(repo, relPath, { rev: revs.before }),
          revs.after === false ? null : gitApi.blobSize(repo, relPath, { rev: revs.after }),
        ])
        preview = { ...info, before, after }
      }

      res.json({
        path: relPath,
        staged,
        untracked,
        sha: sha ?? null,
        base,
        preview,
        ...highlight,
        ...parsed,
      })
    }),
  )

  app.get(
    '/api/log',
    wrap(async (req, res) => {
      const limit = clamp(Number.parseInt(req.query.limit ?? '100', 10), 1, 500, 100)
      const skip = clamp(Number.parseInt(req.query.skip ?? '0', 10), 0, 1e6, 0)
      const all = req.query.all !== '0' && req.query.all !== 'false'

      // 없는 ref거나 옵션처럼 생긴 값이면 무시하고 전체를 보여준다
      const ref = req.query.ref ? await gitApi.resolveRef(repo, req.query.ref) : null

      const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : ''
      const searchIn = SEARCH_MODES.has(req.query.in) ? req.query.in : 'message'

      res.json(await gitApi.commitLog(repo, { limit, skip, all, ref, query, searchIn }))
    }),
  )

  // 파일 목록은 자주 열리고(⌘P) 잘 안 바뀐다. 워킹트리가 바뀌면 버린다.
  let fileCache = null

  app.get(
    '/api/files',
    wrap(async (_req, res) => {
      if (!fileCache) fileCache = await gitApi.listFiles(repo)
      res.json({ files: fileCache })
    }),
  )

  app.get(
    '/api/file',
    wrap(async (req, res) => {
      const relPath = req.query.path
      safeJoin(repo, relPath)
      const sha = validSha(req.query.sha)
      const [content, highlight] = await Promise.all([
        gitApi.fileContent(repo, relPath, { sha }),
        highlightInfo(repo, relPath),
      ])

      // 이미지를 ⌘P로 열면 "바이너리 파일입니다"가 아니라 그림을 본다
      const info = previewInfo(relPath)
      const preview = info
        ? { ...info, before: null, after: await gitApi.blobSize(repo, relPath, { rev: sha }) }
        : null

      res.json({ path: relPath, sha: sha ?? null, preview, ...highlight, ...content })
    }),
  )

  /**
   * 미리보기 원본 바이트 (이미지).
   *
   * `<img src>`로 불리므로 헤더를 붙일 수 없다 — 토큰은 쿼리(`?t=`)로 받는다.
   * Content-Type은 확장자 표에서 온 값만 쓰고 `nosniff`를 붙인다. svg는 문서에
   * 심지 않고 `<img>`로만 그리므로 안의 스크립트가 실행되지 않는다.
   */
  app.get(
    '/api/blob',
    wrap(async (req, res) => {
      const relPath = req.query.path
      safeJoin(repo, relPath)

      const info = previewInfo(relPath)
      if (!info) {
        return res.status(415).json({ error: '미리볼 수 없는 형식입니다' })
      }

      const side = req.query.side === 'before' ? 'before' : 'after'
      const sha = validSha(req.query.sha)
      const staged = req.query.staged === '1' || req.query.staged === 'true'
      const untracked = req.query.untracked === '1' || req.query.untracked === 'true'
      const base = req.query.base === '1' || req.query.base === 'true'
      const rev = previewRev({
        side,
        sha,
        staged,
        base,
        untracked,
        baselineRef: base ? gitApi.baselineRef() : null,
      })
      if (rev === false) return res.status(404).json({ error: '그 쪽에는 파일이 없습니다' })

      const blob = await gitApi.readBlob(repo, relPath, { rev, maxBytes: MAX_PREVIEW_BYTES })
      if (!blob) return res.status(404).json({ error: '내용을 찾을 수 없습니다' })
      if (blob.tooLarge) {
        return res.status(413).json({ error: '너무 커서 미리보기를 하지 않습니다', size: blob.size })
      }

      res.set('Content-Type', info.mime)
      res.set('X-Content-Type-Options', 'nosniff')
      res.set('Content-Disposition', 'inline')
      // 워킹트리는 계속 바뀌고, git 객체는 내용이 곧 이름이라 바뀌지 않는다
      res.set('Cache-Control', rev === null || rev === '' ? 'no-store' : 'max-age=31536000, immutable')
      res.send(blob.buffer)
    }),
  )

  /**
   * AI가 만든 변경에서 사람이 놓치기 쉬운 지점.
   *
   * 린터가 아니라 "여기 한 번 보라"는 표시다. 판정을 내리지 않고 개수와 예시만 준다.
   */
  app.get(
    '/api/risks',
    wrap(async (_req, res) => {
      const raw = await gitApi.worktreeDiff(repo, gitDir)
      res.json(analyzeRisks(splitDiffFiles(raw)))
    }),
  )

  /**
   * "확인함" 표시. 브라우저 localStorage에 두면 grmide가 다른 포트로 뜰 때
   * (4317이 사용 중일 때) 다른 origin이 되어 진행률이 초기화된다.
   */
  app.get(
    '/api/reviewed',
    wrap(async (_req, res) => {
      const state = await readState(gitDir)
      res.json({ marks: state.reviewed })
    }),
  )

  app.put(
    '/api/reviewed',
    wrap(async (req, res) => {
      const marks = await saveReviewed(gitDir, req.body?.marks)
      res.json({ marks })
    }),
  )

  /**
   * 코멘트가 달린 파일들을 경로당 한 번만 읽는다.
   *
   * 반영 판정에 필요한 것은 "지금 그 코드가 파일에 있나"뿐이라, 파일 하나를
   * 여러 코멘트가 함께 쓴다.
   */
  async function readCommentedFiles(comments) {
    const paths = [...new Set(comments.filter((c) => !c.sha).map((c) => c.path))]
    const files = new Map()
    await Promise.all(
      paths.map(async (relPath) => {
        try {
          const abs = safeJoin(repo, relPath)
          const [text, stat] = await Promise.all([
            fs.promises.readFile(abs, 'utf8'),
            fs.promises.stat(abs),
          ])
          files.set(relPath, { text, mtime: stat.mtimeMs })
        } catch {
          files.set(relPath, { text: null, mtime: null })
        }
      }),
    )
    return files
  }

  // --- 리뷰 코멘트: 사람의 판단을 AI에게 되돌리는 경로
  app.get(
    '/api/comments',
    wrap(async (req, res) => {
      const state = await readState(gitDir)
      const files = await readCommentedFiles(state.comments)
      const comments = attachStatus(state.comments, files)

      // ids를 주면 그것만으로 프롬프트를 만든다 — 보낼 것을 골라 보내는 화면용
      const wanted =
        typeof req.query.ids === 'string' && req.query.ids
          ? new Set(req.query.ids.split(',').filter(Boolean))
          : null
      const chosen = wanted ? state.comments.filter((c) => wanted.has(c.id)) : state.comments

      res.json({ comments, prompt: buildPrompt(chosen) })
    }),
  )

  app.post(
    '/api/comments',
    wrap(async (req, res) => {
      const { path: relPath, line, endLine, side, code, text, sha } = req.body ?? {}
      safeJoin(repo, relPath)
      if (typeof text !== 'string' || !text.trim()) {
        throw Object.assign(new Error('코멘트 내용이 비어 있습니다'), { status: 400 })
      }
      const comment = await addComment(gitDir, {
        path: relPath,
        line,
        endLine,
        side,
        code,
        text: text.trim(),
        sha: validSha(sha),
      })
      res.json({ comment })
    }),
  )

  app.patch(
    '/api/comments',
    wrap(async (req, res) => {
      const { id, text } = req.body ?? {}
      if (!id || typeof text !== 'string' || !text.trim()) {
        throw Object.assign(new Error('id와 내용이 필요합니다'), { status: 400 })
      }
      const updated = await updateComment(gitDir, id, text.trim())
      if (!updated) throw Object.assign(new Error('코멘트를 찾을 수 없습니다'), { status: 404 })
      res.json({ comment: updated })
    }),
  )

  app.delete(
    '/api/comments',
    wrap(async (req, res) => {
      if (req.query.all === '1') {
        await clearComments(gitDir)
        return res.json({ ok: true })
      }
      // 반영된 것 정리 — 한 번에 여러 개를 지운다
      if (typeof req.query.ids === 'string' && req.query.ids) {
        const ids = req.query.ids.split(',').filter(Boolean)
        let count = 0
        for (const id of ids) if (await removeComment(gitDir, id)) count += 1
        return res.json({ ok: true, removed: count })
      }
      const removed = await removeComment(gitDir, req.query.id)
      if (!removed) throw Object.assign(new Error('코멘트를 찾을 수 없습니다'), { status: 404 })
      res.json({ ok: true })
    }),
  )

  /**
   * 컨텍스트 바구니 — "이것도 같이 봐"를 모아 두는 곳.
   *
   * 내용은 **넘길 때** 읽는다. 담을 때 얼려 두면 AI가 고친 뒤에는 프롬프트가
   * 사실과 달라진다. 바구니는 "무엇을 볼지"만 들고 있다.
   */
  async function contextSources(items) {
    const sources = new Map()
    await Promise.all(
      items.map(async (item) => {
        const key = itemKey(item)
        if (item.kind === 'grep') {
          const result = await gitApi.grep(repo, item.query, { limit: MAX_GREP_HITS * 4 })
          sources.set(key, { hits: result.hits, total: result.hits.length })
          return
        }
        try {
          const abs = safeJoin(repo, item.path)
          const text = await fs.promises.readFile(abs, 'utf8')
          const all = text.split('\n')
          if (all.length && all[all.length - 1] === '') all.pop()
          const lines =
            item.kind === 'range'
              ? all
                  .slice(item.line - 1, item.endLine)
                  // 구간은 줄 번호를 붙여 준다 — AI가 어디를 말하는지 알아야 한다
                  .map((line, i) => `${item.line + i}: ${line}`)
              : all
          sources.set(key, { lines })
        } catch {
          sources.set(key, { missing: true })
        }
      }),
    )
    return sources
  }

  app.get(
    '/api/context',
    wrap(async (_req, res) => {
      const state = await readState(gitDir)
      const sources = await contextSources(state.context)
      res.json({ items: state.context, prompt: buildContextPrompt(state.context, sources) })
    }),
  )

  app.post(
    '/api/context',
    wrap(async (req, res) => {
      const item = normalizeItem(req.body)
      if (!item) throw Object.assign(new Error('담을 수 없는 항목입니다'), { status: 400 })
      if (item.path) safeJoin(repo, item.path)
      const result = await addContext(gitDir, item, itemKey(item))
      res.json(result)
    }),
  )

  app.delete(
    '/api/context',
    wrap(async (req, res) => {
      if (req.query.all === '1') {
        await clearContext(gitDir)
        return res.json({ ok: true })
      }
      const removed = await removeContext(gitDir, req.query.id)
      if (!removed) throw Object.assign(new Error('항목을 찾을 수 없습니다'), { status: 404 })
      res.json({ ok: true })
    }),
  )

  app.get(
    '/api/grep',
    wrap(async (req, res) => {
      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : ''
      const limit = clamp(Number.parseInt(req.query.limit ?? '400', 10), 1, 2000, 400)
      res.json({ query, ...(await gitApi.grep(repo, query, { limit })) })
    }),
  )

  app.get(
    '/api/refs',
    wrap(async (_req, res) => {
      res.json({ refs: await gitApi.refList(repo) })
    }),
  )

  app.get(
    '/api/commit',
    wrap(async (req, res) => {
      const sha = validSha(req.query.sha)
      if (!sha) {
        throw Object.assign(new Error('sha 파라미터가 필요합니다'), { status: 400 })
      }
      res.json(await gitApi.commitDetail(repo, sha))
    }),
  )

  app.post(
    '/api/stage',
    wrap(async (req, res) => {
      safeJoin(repo, req.body?.path)
      await gitApi.stageFile(repo, req.body.path)
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/unstage',
    wrap(async (req, res) => {
      safeJoin(repo, req.body?.path)
      await gitApi.unstageFile(repo, req.body.path)
      res.json({ ok: true })
    }),
  )

  // --- 실시간 갱신: AI가 파일을 쓰는 동안 브라우저가 스스로 따라온다.
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    // 재접속 간격. 너무 짧으면(1초) grmide를 끈 뒤에도 브라우저가 계속
    // 재접속을 시도하면서 페이지가 먹통이 된다.
    res.write('retry: 3000\n\n')
    clients.add(res)

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(keepAlive)
      clients.delete(res)
    })
  })

  function broadcast(event, data = {}) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) client.write(payload)
  }

  const watcher = createWatcher(repo, () => {
    fileCache = null
    broadcast('changed')
  })

  // --- 정적 파일: dev 모드에서는 vite dev server가 프론트를 서빙한다.
  if (!dev) {
    if (!fs.existsSync(WEB_DIST)) {
      console.warn(`[grmide] 빌드 결과물이 없습니다: ${WEB_DIST}\n            npm run build 를 먼저 실행하세요.`)
    }
    app.use(express.static(WEB_DIST, { index: false }))
    app.get('*', (_req, res) => {
      const indexHtml = path.join(WEB_DIST, 'index.html')
      if (!fs.existsSync(indexHtml)) {
        return res.status(503).send('빌드 결과물이 없습니다. npm run build 를 실행하세요.')
      }
      res.sendFile(indexHtml)
    })
  }

  /**
   * SSE 연결을 먼저 끊어야 한다. 열린 채로 두면 `server.close()`가 그 연결이
   * 끝나기를 기다리므로, 브라우저 탭이 열려 있는 동안 Ctrl-C로 종료되지 않는다.
   */
  async function close() {
    for (const client of clients) client.end()
    clients.clear()
    await watcher.close()
  }

  return { app, close }
}

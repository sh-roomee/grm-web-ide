import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'

import * as gitApi from './git.js'
import { parseUnifiedDiff } from './diff.js'
import { highlightInfo } from './language.js'
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

export function createServer({ repo, token, dev = false }) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.disable('x-powered-by')

  const clients = new Set()

  // --- 인증: 로컬 바인딩이지만 같은 머신의 다른 프로세스/사이트가 붙는 것을 막는다.
  app.use('/api', (req, res, next) => {
    const provided = req.get('x-gitshow-token') || req.query.t
    if (provided !== token) return res.status(401).json({ error: '토큰이 유효하지 않습니다' })
    next()
  })

  const wrap = (handler) => (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const status = err.status ?? 500
      if (status >= 500) console.error('[gitshow]', err)
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
      res.json(await gitApi.status(repo))
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
      const [raw, highlight] = await Promise.all([
        gitApi.fileDiff(repo, relPath, { staged, untracked, context }),
        highlightInfo(repo, relPath),
      ])
      const parsed = parseUnifiedDiff(raw)
      res.json({ path: relPath, staged, untracked, ...highlight, ...parsed })
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
    // 재접속 간격. 너무 짧으면(1초) gitshow를 끈 뒤에도 브라우저가 계속
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

  const watcher = createWatcher(repo, () => broadcast('changed'))

  // --- 정적 파일: dev 모드에서는 vite dev server가 프론트를 서빙한다.
  if (!dev) {
    if (!fs.existsSync(WEB_DIST)) {
      console.warn(`[gitshow] 빌드 결과물이 없습니다: ${WEB_DIST}\n            npm run build 를 먼저 실행하세요.`)
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

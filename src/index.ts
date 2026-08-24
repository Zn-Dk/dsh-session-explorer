/**
 * dsh-session-explorer Host 装配层。
 *
 * - 打开/初始化 ~/.dsh/storages/session-explorer.sqlite（trigram FTS5 索引）
 * - RPC /dsh-session-explorer（loopback）
 * - 事件同步：agent/turn-stopping 增量 + 启动对账 + 手动 rebuild
 * - 依赖全部可选（ctx.get），服务缺失时降级为可报告错误，不让插件加载失败
 */

import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionIndex, type SessionMeta } from './indexer.js'
import { foldSession, foldTitle } from './transcript.js'
import { dispatch } from './rpc.js'
import type { ExplorerRpc, IndexStatus, RebuildResponse } from './protocol.js'

export const name = 'dsh-session-explorer'

/** RPC 通道名（client 侧共用）。 */
export const CHANNEL = '/dsh-session-explorer'

/** 索引库路径：~/.dsh/storages/session-explorer.sqlite。 */
export function indexPath(): string {
  const storages = dshHomePath('storages')
  mkdirSync(storages, { recursive: true, mode: 0o700 })
  return join(storages, 'session-explorer.sqlite')
}

interface EventLike {
  type?: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}
interface SessionEventLike { [key: string]: unknown }

interface SessionHeaderLike {
  id?: unknown
  createdAt?: number
  cwd?: string
}

interface PersistenceLike {
  listSnapshots?: () => Promise<Array<{ header: SessionHeaderLike; revision?: unknown }>>
  list?: () => Promise<SessionHeaderLike[]>
  inspect?: (id: string) => Promise<{ meta: SessionHeaderLike; events: SessionEventLike[] }>
}

interface SessionsLike {
  get?: (id: string) => { id?: unknown } | undefined
}

interface AgentLike {
  session?: { id?: unknown }
  ctx?: {
    on?: (event: string, listener: (payload?: unknown) => void) => () => void
    effect?: (dispose: () => unknown, label: string) => void
  }
}

interface AgentsLike {
  roots?: () => AgentLike[]
}

interface ConnectionLike {
  rpc?: {
    handle: (channel: string, handler: unknown, opts: { authority: string }) => () => void | unknown
  }
}

interface WebLike {
  connection?: ConnectionLike
}

interface CtxLike {
  get: (service: string) => unknown
  inject: (services: string[], fn: (web: WebLike) => void) => void
  effect: (dispose: () => unknown, label: string) => void
  on: (event: string, listener: (payload?: unknown) => void) => () => void
  logger?: { warn?: (msg: string) => void }
}

const sessionIdOf = (id: unknown): string | null => (typeof id === 'string' && id.length > 0 ? id : null)

/** 同步一个会话的最新日志。 */
async function syncSession(index: SessionIndex, persistence: PersistenceLike, sessionId: string): Promise<boolean> {
  const inspection = await persistence.inspect!(sessionId)
  if (!inspection) return false
  const events = (inspection.events ?? []) as SessionEventLike[]
  const folded = foldSession(sessionId, events as never[])
  const title = foldTitle(events as never[])
  const meta: SessionMeta = {
    sessionId,
    title,
    cwd: typeof inspection.meta?.cwd === 'string' ? inspection.meta.cwd : null,
    createdAt: typeof inspection.meta?.createdAt === 'number' ? inspection.meta.createdAt : 0,
    updatedAt: Date.now(),
  }
  index.upsertSession(meta, folded.messages)
  return true
}

/** 列出所有已知会话 id（优先 snapshot 列表，降级 header 列表）。 */
async function listSessionIds(persistence: PersistenceLike): Promise<string[]> {
  const ids: string[] = []
  if (persistence.listSnapshots) {
    const snapshots = await persistence.listSnapshots()
    for (const snapshot of snapshots) {
      const id = sessionIdOf(snapshot.header?.id)
      if (id) ids.push(id)
    }
  } else if (persistence.list) {
    const headers = await persistence.list()
    for (const header of headers) {
      const id = sessionIdOf(header.id)
      if (id) ids.push(id)
    }
  }
  return ids
}

function errorOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: CtxLike) {
  let index: SessionIndex | null = null
  let disposed = false
  let syncing: Promise<void> | null = null
  const warned: string[] = []

  const warnOnce = (key: string, message: string) => {
    if (!warned.includes(key)) {
      warned.push(key)
      ctx.logger?.warn?.('[dsh-session-explorer] ' + message)
    }
  }

  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined

  try {
    index = SessionIndex.open(indexPath())
  } catch (error) {
    ctx.logger?.warn?.('[dsh-session-explorer] index unavailable: ' + errorOf(error))
    index = null
  }

  const handlers: ExplorerRpc = {
    search: async (request) => {
      if (!index) throw new Error('index unavailable')
      return index.search(request.query, request)
    },
    timeline: async (request) => {
      if (!index) throw new Error('index unavailable')
      return index.timeline(request ?? {})
    },
    preview: async (request) => {
      if (!index) throw new Error('index unavailable')
      return index.preview(request.sessionId, request.seq, request)
    },
    indexStatus: async (): Promise<IndexStatus> => {
      if (!index) throw new Error('index unavailable')
      const ids = persistence ? await listSessionIds(persistence) : []
      return index.indexStatus(ids)
    },
    rebuild: async (): Promise<RebuildResponse> => {
      if (!index) throw new Error('index unavailable')
      if (!persistence?.inspect) {
        throw new Error('sessionPersistence.inspect is not available in this build')
      }
      const ids = await listSessionIds(persistence)
      const failures: RebuildResponse['failures'] = []
      let succeeded = 0
      let failed = 0
      for (const id of ids) {
        try {
          if (await syncSession(index, persistence, id)) succeeded++
          else failed++
        } catch (error) {
          failed++
          failures.push({ sessionId: id, indexed: false, error: errorOf(error) })
        }
      }
      return { total: ids.length, succeeded, failed, failures }
    },
  }

  const onTurnStopping = (payload?: unknown) => {
    if (!index || !persistence?.inspect || syncing) return
    const agent = payload as AgentLike | undefined
    const id = sessionIdOf(agent?.session?.id)
    if (!id) return
    const run = syncSession(index, persistence, id)
      .then(() => {})
      .catch((error) => warnOnce('sync-' + id, 'incremental sync failed for ' + id + ': ' + errorOf(error)))
      .finally(() => {
        syncing = null
      })
    syncing = run
  }

  const attachAgent = (agent: AgentLike) => {
    const agentCtx = agent.ctx
    if (!agentCtx?.on || !agentCtx?.effect) return
    const id = sessionIdOf(agent.session?.id)
    if (!id) return
    agentCtx.effect(() => {
      const stop = agentCtx.on!('agent/turn-stopping', onTurnStopping)
      return () => stop()
    }, 'dsh-session-explorer.turn(' + id + ')')
  }

  const stopCreated = ctx.on('agent/created', (payload) => {
    const agent = (payload as { agent?: AgentLike } | undefined)?.agent
    if (agent) attachAgent(agent)
  })

  if (persistence?.inspect) {
    for (const agent of (ctx.get('agents') as AgentsLike | undefined)?.roots?.() ?? []) attachAgent(agent)
  }

  // 启动对账：把新出现的会话索引起来（失败不阻塞）。
  void (async () => {
    if (!index || !persistence?.inspect) return
    try {
      const ids = await listSessionIds(persistence)
      for (const id of ids) {
        if (disposed) return
        const snap = index.sessionMeta(id)
        if (snap && snap.indexedAt > 0) continue // 已索引；过期以 turn-stopping 增量纠正
        try {
          await syncSession(index, persistence, id)
        } catch (error) {
          warnOnce('reconcile-' + id, 'reconciliation failed for ' + id + ': ' + errorOf(error))
        }
      }
    } catch (error) {
      warnOnce('reconcile', 'reconciliation failed: ' + errorOf(error))
    }
  })()

  let disposeRpc: (() => void) | null = null
  ctx.inject(['connection'], (web) => {
    const rpc = web.connection?.rpc
    if (!rpc) return
    const handler = async (endpoint: string, payload: unknown) => {
      return dispatch(handlers, endpoint, payload)
    }
    const dispose = rpc.handle(CHANNEL, handler, { authority: 'loopback' })
    if (typeof dispose === 'function') disposeRpc = dispose
  })

  return async () => {
    disposed = true
    stopCreated()
    disposeRpc?.()
    if (syncing) await syncing.catch(() => {})
    index?.close()
    index = null
  }
}

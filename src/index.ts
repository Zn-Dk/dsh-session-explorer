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
import { fingerprintOf } from './indexer.js'
import { foldSession, foldTitle } from './transcript.js'
import { dispatch } from './rpc.js'
import type { ExplorerRpc, IndexHealth, IndexStatus, RebuildRequest, RebuildResponse, SyncResponse } from './protocol.js'

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

/** sessionId → revision 映射（listSnapshots 轻量快照，O(1) 不读日志）。 */
async function listSnapshotRevisions(persistence: PersistenceLike): Promise<Map<string, string> | null> {
  if (!persistence.listSnapshots) return null
  const snapshots = await persistence.listSnapshots()
  const map = new Map<string, string>()
  for (const snapshot of snapshots) {
    const id = sessionIdOf(snapshot.header?.id)
    const rev = typeof snapshot.revision === 'string' ? snapshot.revision : String(snapshot.revision ?? '')
    if (id && rev) map.set(id, rev)
  }
  return map
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
async function syncSession(index: SessionIndex, persistence: PersistenceLike, sessionId: string, revision?: string | null): Promise<boolean> {
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
    logFingerprint: fingerprintOf(folded.messages),
    logRevision: revision ?? null,
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
  const agentsOf = () => (ctx.get('agents') as AgentsLike | undefined)?.roots?.() ?? []

  try {
    index = SessionIndex.open(indexPath())
  } catch (error) {
    ctx.logger?.warn?.('[dsh-session-explorer] index unavailable: ' + errorOf(error))
    index = null
  }

  // 面板打开时同步：live 会话 + 从未索引的新会话（串行，量小安全）。
  const syncNow = async (): Promise<SyncResponse> => {
    if (!persistence?.inspect) return { synced: 0, failed: 0 }
    const targets = new Set<string>()
    for (const agent of agentsOf()) {
      const id = sessionIdOf(agent.session?.id)
      if (id !== null) targets.add(id)
    }
    try {
      for (const id of await listSessionIds(persistence)) {
        const snap = index?.sessionMeta(id)
        if (!snap || snap.indexedAt === 0) targets.add(id)
      }
    } catch (error) {
      warnOnce('sync-list', 'sync session listing failed: ' + errorOf(error))
    }
    let synced = 0
    let failed = 0
    const revisions = await listSnapshotRevisions(persistence)
    for (const id of targets) {
      try {
        await syncSession(index!, persistence, id, revisions?.get(id) ?? null)
        synced++
      } catch (error) {
        failed++
        const message = errorOf(error)
        warnOnce('sync-' + id, 'sync failed for ' + id + ': ' + message)
        try { index?.markFailed(id, message) } catch { /* 记录失败尽力而为 */ }
      }
    }
    return { synced, failed }
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
    sync: async (): Promise<SyncResponse> => {
      if (!index) throw new Error('index unavailable')
      return syncNow()
    },
    healthCheck: async (): Promise<IndexHealth> => {
      if (!index) throw new Error('index unavailable')
      return index.healthCheck()
    },
    rebuild: async (request: RebuildRequest): Promise<RebuildResponse> => {
      if (!index) throw new Error('index unavailable')
      if (!persistence?.inspect) {
        throw new Error('sessionPersistence.inspect is not available in this build')
      }
      const ids = await listSessionIds(persistence)
      const failures: RebuildResponse['failures'] = []
      const mode = request.mode
      let added = 0
      let removed = 0
      let refreshed = 0
      let skipped = 0
      let succeeded = 0
      let failed = 0

      const rebuildOne = async (id: string, revision?: string | null): Promise<void> => {
        try {
          if (await syncSession(index!, persistence, id, revision)) succeeded++
          else failed++
        } catch (error) {
          failed++
          const message = errorOf(error)
          failures.push({ sessionId: id, indexed: false, error: message })
          try { index!.markFailed(id, message) } catch { /* 记录失败尽力而为 */ }
        }
      }

      if (mode === 'full') {
        // 全量：清库后逐会话重建（严格串行，一次只驻留一个会话内存，防 OOM）
        index.reset()
        const revisions = await listSnapshotRevisions(persistence)
        for (const id of ids) {
          if (disposed) break
          await rebuildOne(id, revisions?.get(id) ?? null)
        }
        added = succeeded
      } else {
        // 增量：revision 快速 diff（O(1)）+ 幽灵清理 + 变化会话重刷（严格串行）
        const known = new Set(ids)
        const revisions = await listSnapshotRevisions(persistence)
        const storedRevisions = index.listRevisions()
        const storedFingerprints = index.listFingerprints()
        // 1) 幽灵：索引有但磁盘无 → 删除
        for (const id of storedRevisions.keys()) {
          if (!known.has(id)) {
            try {
              index.deleteSession(id)
              removed++
            } catch (error) {
              failures.push({ sessionId: id, indexed: false, error: 'ghost delete failed: ' + errorOf(error) })
            }
          }
        }
        // 2) 逐会话：revision 相同 → 跳过（不 inspect）；不同/缺失 → 重刷
        for (const id of ids) {
          if (disposed) break
          const currentRev = revisions?.get(id) ?? null
          const storedRev = storedRevisions.get(id)
          const storedFp = storedFingerprints.get(id)
          // 已索引过，且有 revision 且与当前一致 → 直接跳过（快速路径）
          if (storedRev !== undefined && storedRev !== null && currentRev !== null && storedRev === currentRev) {
            skipped++
            continue
          }
          // 其余情况：未索引 / revision 变化 / revision 缺失（老库）→ 重刷
          try {
            const inspection = await persistence.inspect!(id)
            const events = (inspection.events ?? []) as SessionEventLike[]
            const folded = foldSession(id, events as never[])
            const title = foldTitle(events as never[])
            const currentFp = fingerprintOf(folded.messages)
            const meta: SessionMeta = {
              sessionId: id,
              title,
              cwd: typeof inspection.meta?.cwd === 'string' ? inspection.meta.cwd : null,
              createdAt: typeof inspection.meta?.createdAt === 'number' ? inspection.meta.createdAt : 0,
              updatedAt: Date.now(),
              logFingerprint: currentFp,
              logRevision: currentRev,
            }
            index!.upsertSession(meta, folded.messages)
            if (storedRev === undefined || storedFp === undefined) added++
            else refreshed++
            succeeded++
          } catch (error) {
            failed++
            const message = errorOf(error)
            failures.push({ sessionId: id, indexed: false, error: message })
            try { index!.markFailed(id, message) } catch { /* 尽力而为 */ }
          }
        }
      }
      return { mode, total: ids.length, added, removed, refreshed, skipped, succeeded, failed, failures }
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
      const stopTurn = agentCtx.on!('agent/turn-stopping', onTurnStopping)
      const stopStatus = agentCtx.on!('agent/status', onTurnStopping)
      return () => {
        stopTurn()
        stopStatus()
      }
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

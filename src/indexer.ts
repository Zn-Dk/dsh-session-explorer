/**
 * indexer.ts —— 插件自有的 SQLite FTS5 trigram 索引（读模型）。
 *
 * 数据库位置由 host 解析（~/.dsh/storages/session-explorer.sqlite），本模块
 * 只收路径，不依赖 cordis。安全策略：
 * - application_id + user_version 双校验，外来/版本不匹配的库直接拒开；
 * - 文件权限 0600（含 -wal/-shm）；
 * - 每会话 upsert = 事务内先 'delete' FTS 行再重插（external content 表）。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import type {
  IndexableMessage,
  MessageHit,
  PreviewPage,
  TimelineNode,
  IndexStatus,
  MessageKind,
} from './protocol.js'
import { makeSnippet } from './transcript.js'

/** 私有库标记。 */
export const DB_APP_ID = 0x44534530 // 'DSE0'
/** 结构版本：schema 变更时 +1。 */
export const DB_USER_VERSION = 3

/** 每会话元数据（同步层传入）。 */
export interface SessionMeta {
  sessionId: string
  title: string | null
  cwd: string | null
  createdAt: number
  updatedAt: number
  /** 源日志指纹（增量重建判断内容是否变化）；未提供时写入 null。 */
  logFingerprint?: string | null
  /** 源日志 revision（engine listSnapshots 的轻量变更 token；O(1) 快速 diff）。 */
  logRevision?: string | null
}

/** djb2 字符串哈希（轻量、稳定，不追求密码学强度）。 */
function djb2(text: string): number {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

/** 从折叠后的消息计算源日志指纹（内容变化 → 指纹变化）。 */
export function fingerprintOf(messages: IndexableMessage[]): string {
  if (messages.length === 0) return '0:0:0:0'
  let contentHash = 5381
  let lastSeq = 0
  let lastTime = 0
  for (const message of messages) {
    // 只哈希 textMain/textTool，避免 sessionId/turn 等不影响检索的字段造成无谓重刷
    contentHash = ((contentHash << 5) + contentHash + djb2(message.textMain)) | 0
    contentHash = ((contentHash << 5) + contentHash + djb2(message.textTool)) | 0
    if (message.seq > lastSeq) {
      lastSeq = message.seq
      lastTime = message.time
    }
  }
  return messages.length + ':' + lastSeq + ':' + lastTime + ':' + (contentHash >>> 0)
}

/** bm25 列权重：text_main 10 倍于 text_tool。 */
const RANK = 'bm25(messages_fts, 10.0, 1.0)'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    cwd TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    tool_count INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL,
    log_fingerprint TEXT,
    log_revision TEXT,
    error TEXT
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    time INTEGER NOT NULL,
    turn INTEGER,
    text_main TEXT NOT NULL DEFAULT '',
    text_tool TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text_main, text_tool,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram'
  )`,
]

export interface SearchOptions {
  kinds?: MessageKind[]
  from?: number
  to?: number
  cwd?: string
  limit?: number
  offset?: number
}

export interface PreviewOptions {
  before?: number
  after?: number
}

export class SessionIndex {
  private db: DatabaseSync
  readonly path: string

  private constructor(db: DatabaseSync, path: string) {
    this.db = db
    this.path = path
  }

  /** 打开（必要时初始化）索引库；拒绝外来/版本不符的库。 */
  static open(path: string): SessionIndex {
    const existed = fs.existsSync(path)
    const db = new DatabaseSync(path)
    try {
      const appId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
      const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (existed) {
        if (appId !== DB_APP_ID) {
          db.close()
          throw new Error(`refusing foreign sqlite file (application_id=${appId}): ${path}`)
        }
        // 仅支持向前迁移；版本高于当前实现（或低于 v1）拒绝
        if (userVersion > DB_USER_VERSION || userVersion < 1) {
          db.close()
          throw new Error(`refusing version mismatch (user_version=${userVersion}, want ${DB_USER_VERSION}): ${path}`)
        }
      } else {
        db.exec(`PRAGMA application_id = ${DB_APP_ID}`)
        db.exec(`PRAGMA user_version = ${DB_USER_VERSION}`)
      }
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      for (const stmt of SCHEMA) db.exec(stmt)
      // 迁移：v1 → v2 补 log_fingerprint 列（无数据，按缺指纹处理 → 增量重建时全量重刷一次）
      if (existed && userVersion >= 1 && userVersion < DB_USER_VERSION) {
        const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
        if (!columns.some((column) => column.name === 'log_fingerprint')) {
          db.exec('ALTER TABLE sessions ADD COLUMN log_fingerprint TEXT')
        }
        if (!columns.some((column) => column.name === 'log_revision')) {
          db.exec('ALTER TABLE sessions ADD COLUMN log_revision TEXT')
        }
        if (!columns.some((column) => column.name === 'error')) {
          db.exec('ALTER TABLE sessions ADD COLUMN error TEXT')
        }
        db.exec(`PRAGMA user_version = ${DB_USER_VERSION}`)
      }
      const index = new SessionIndex(db, path)
      index.chmod()
      return index
    } catch (error) {
      try { db.close() } catch { /* already closed */ }
      throw error
    }
  }

  /** 0600 权限（主文件 + WAL 附属文件）。 */
  private chmod(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = this.path + suffix
      if (fs.existsSync(file)) {
        try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
      }
    }
  }

  close(): void {
    this.db.close()
  }

  /** FTS5 查询串转义：双引号包裹并转义内部引号。 */
  static quoteQuery(raw: string): string {
    return '"' + raw.replaceAll('"', '""') + '"'
  }

  /** LIKE 模式转义（% _ \）。 */
  static escapeLike(raw: string): string {
    return raw.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  }

  /** 查询是否短于 trigram 最小 token 长度（3 个 code point）。 */
  static isShortQuery(raw: string): boolean {
    return [...raw.replace(/\s+/g, '')].length < 3
  }

  /** 全量替换一个会话的索引行（事务）。 */
  upsertSession(meta: SessionMeta, messages: IndexableMessage[]): void {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, text_main, text_tool)
        SELECT 'delete', rowid, text_main, text_tool FROM messages WHERE session_id = ?`).run(meta.sessionId)
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(meta.sessionId)

      const insert = this.db.prepare(`INSERT INTO messages(session_id, seq, kind, time, turn, text_main, text_tool)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      const insertFts = this.db.prepare(`INSERT INTO messages_fts(rowid, text_main, text_tool) VALUES (?, ?, ?)`)
      let toolCount = 0
      for (const message of messages) {
        const result = insert.run(
          message.sessionId, message.seq, message.kind, message.time,
          message.turn, message.textMain, message.textTool,
        )
        insertFts.run(result.lastInsertRowid, message.textMain, message.textTool)
        if (message.kind === 'tool') toolCount++
      }

      this.db.prepare(`INSERT INTO sessions(session_id, title, cwd, created_at, updated_at, message_count, tool_count, indexed_at, log_fingerprint, log_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title, cwd = excluded.cwd, created_at = excluded.created_at,
          updated_at = excluded.updated_at, message_count = excluded.message_count,
          tool_count = excluded.tool_count, indexed_at = excluded.indexed_at,
          log_fingerprint = excluded.log_fingerprint, log_revision = excluded.log_revision,
          error = NULL`)
        .run(meta.sessionId, meta.title, meta.cwd, meta.createdAt, meta.updatedAt, messages.length, toolCount, now, meta.logFingerprint ?? null, meta.logRevision ?? null)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 删除一个会话的全部索引行。 */
  deleteSession(sessionId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, text_main, text_tool)
        SELECT 'delete', rowid, text_main, text_tool FROM messages WHERE session_id = ?`).run(sessionId)
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 消息级全文检索。 */
  search(query: string, options: SearchOptions = {}): { items: MessageHit[]; nextOffset: number | null } {
    const q = query.trim()
    if (!q) return { items: [], nextOffset: null }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const offset = options.offset ?? 0

    const short = SessionIndex.isShortQuery(q)
    const where: string[] = short
      ? ['(m.text_main LIKE ? ESCAPE \'\\\' OR m.text_tool LIKE ? ESCAPE \'\\\')']
      : ['messages_fts MATCH ?']
    const params: (string | number)[] = short
      ? [`%${SessionIndex.escapeLike(q)}%`, `%${SessionIndex.escapeLike(q)}%`]
      : [SessionIndex.quoteQuery(q)]
    if (options.kinds && options.kinds.length > 0) {
      where.push(`m.kind IN (${options.kinds.map(() => '?').join(',')})`)
      params.push(...options.kinds)
    }
    if (typeof options.from === 'number') {
      where.push('m.time >= ?')
      params.push(options.from)
    }
    if (typeof options.to === 'number') {
      where.push('m.time <= ?')
      params.push(options.to)
    }
    if (options.cwd) {
      where.push('s.cwd = ?')
      params.push(options.cwd)
    }

    // 去重：DSH fork/续接会话共享父历史，同一条消息（相同 seq+kind+正文）会在
    // 多个 session 各存一份。用 GROUP BY (seq, kind, text_main) 保留每组一行；
    // SQLite bare-column 特性会保留每组第一行，配合 ORDER BY 优先留标题非空、
    // indexed_at 更晚的 session（fork 后的会话通常更有意义）。
    // 注意：bm25 不能出现在窗口函数子查询内，故 GROUP BY 必须与 bm25 同层，
    // 去重顺序由 ORDER BY 的 title/indexed_at 前缀保证。
    const rows = (short
      ? this.db.prepare(`SELECT
          m.session_id, m.seq, m.kind, m.time, m.turn,
          m.text_main, m.text_tool,
          s.title, s.cwd,
          0 AS rank
        FROM messages m
        LEFT JOIN sessions s ON s.session_id = m.session_id
        WHERE ${where.join(' AND ')}
        GROUP BY m.seq, m.kind, m.text_main
        ORDER BY s.indexed_at DESC, m.time DESC
        LIMIT ? OFFSET ?`).all(...params, limit + 1, offset)
      : this.db.prepare(`SELECT
          m.session_id, m.seq, m.kind, m.time, m.turn,
          m.text_main, m.text_tool,
          s.title, s.cwd,
          0 AS rank
        FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        LEFT JOIN sessions s ON s.session_id = m.session_id
        WHERE ${where.join(' AND ')}
        GROUP BY m.seq, m.kind, m.text_main
        ORDER BY s.indexed_at DESC, m.time DESC
        LIMIT ? OFFSET ?`).all(...params, limit + 1, offset)) as Array<Record<string, unknown>>

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items: MessageHit[] = page.map((row) => {
      const textMain = String(row.text_main ?? '')
      const textTool = String(row.text_tool ?? '')
      const lowerQ = q.toLowerCase()
      const mainHit = textMain.toLowerCase().includes(lowerQ)
      const field: 'main' | 'tool' = mainHit ? 'main' : 'tool'
      const source = field === 'main' ? textMain : textTool
      return {
        sessionId: String(row.session_id),
        seq: Number(row.seq),
        kind: row.kind as MessageKind,
        time: Number(row.time),
        turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
        sessionTitle: row.title === null || row.title === undefined ? null : String(row.title),
        cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
        snippet: makeSnippet(source, q),
        hitField: field,
      }
    })
    return { items, nextOffset: hasMore ? offset + limit : null }
  }

  /** 时间线：会话级摘要（不加载消息）。 */
  timeline(options: { from?: number; to?: number; limit?: number } = {}): TimelineNode[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
    const where: string[] = []
    const params: number[] = []
    if (typeof options.from === 'number') {
      where.push('updated_at >= ?')
      params.push(options.from)
    }
    if (typeof options.to === 'number') {
      where.push('updated_at <= ?')
      params.push(options.to)
    }
    const rows = this.db.prepare(`SELECT session_id, title, cwd, created_at, updated_at, message_count, tool_count
      FROM sessions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC
      LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      title: row.title === null || row.title === undefined ? null : String(row.title),
      cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      messageCount: Number(row.message_count),
      toolCount: Number(row.tool_count),
    }))
  }

  /** 预览页：焦点消息 + 相邻窗口。 */
  preview(sessionId: string, seq: number, options: PreviewOptions = {}): PreviewPage | null {
    const before = Math.min(Math.max(options.before ?? 20, 0), 50)
    const after = Math.min(Math.max(options.after ?? 20, 0), 50)

    const focus = this.db.prepare(`SELECT session_id, seq, kind, time, turn, text_main, text_tool
      FROM messages WHERE session_id = ? AND seq = ?`).get(sessionId, seq) as Record<string, unknown> | undefined
    if (!focus) return null

    const beforeRows = this.db.prepare(`SELECT session_id, seq, kind, time, turn, text_main, text_tool
      FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
      .all(sessionId, seq, before) as Array<Record<string, unknown>>
    const afterRows = this.db.prepare(`SELECT session_id, seq, kind, time, turn, text_main, text_tool
      FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(sessionId, seq, after) as Array<Record<string, unknown>>

    const session = this.db.prepare('SELECT title, cwd FROM sessions WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined

    const toMessage = (row: Record<string, unknown>): IndexableMessage => ({
      sessionId: String(row.session_id),
      seq: Number(row.seq),
      kind: row.kind as MessageKind,
      time: Number(row.time),
      turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
      textMain: String(row.text_main ?? ''),
      textTool: String(row.text_tool ?? ''),
    })

    return {
      sessionId,
      sessionTitle: session?.title === null || session?.title === undefined ? null : String(session?.title ?? null),
      cwd: session?.cwd === null || session?.cwd === undefined ? null : String(session?.cwd ?? null),
      focus: toMessage(focus),
      context: [...beforeRows.reverse(), ...afterRows].map(toMessage),
    }
  }

  /** 索引健康状态（与外部已知会话列表对比）。 */
  indexStatus(knownSessionIds: string[]): IndexStatus {
    const indexedRows = this.db.prepare('SELECT session_id, indexed_at, error FROM sessions').all() as Array<Record<string, unknown>>
    const known = new Set(knownSessionIds)
    const failedIds = new Set<string>()
    const indexedOk = new Set<string>()
    for (const row of indexedRows) {
      const id = String(row.session_id)
      if (row.error !== null && row.error !== undefined) failedIds.add(id)
      else indexedOk.add(id)
    }
    // 待同步 = 磁盘有但既未成功索引、也未标记失败
    const stale = knownSessionIds.filter((id) => !indexedOk.has(id) && !failedIds.has(id))
    // 幽灵 = 索引里有（成功或失败）但磁盘已不存在
    const ghost = indexedRows.filter((row) => !known.has(String(row.session_id)))
    let lastSyncAt: number | null = null
    for (const row of indexedRows) {
      const value = Number(row.indexed_at)
      if (lastSyncAt === null || value > lastSyncAt) lastSyncAt = value
    }
    // 成功索引数只算「磁盘存在」的（排除幽灵），避免 337/336 溢出
    const indexedSessions = knownSessionIds.filter((id) => indexedOk.has(id)).length
    return {
      totalSessions: knownSessionIds.length,
      indexedSessions,
      staleSessions: stale.length,
      failedSessions: failedIds.size,
      lastSyncAt,
      ghostSessions: ghost.length,
    }
  }

  /** 会话的索引行数（测试/诊断用）。 */
  countMessages(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }
    return row.n
  }

  /** 会话元数据快照（同步层判断是否过期用）。 */
  sessionMeta(sessionId: string): { indexedAt: number; messageCount: number } | null {
    const row = this.db.prepare('SELECT indexed_at, message_count FROM sessions WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return { indexedAt: Number(row.indexed_at), messageCount: Number(row.message_count) }
  }

  /** 记录一个会话索引失败（损坏等），供 indexStatus 区分「待同步」与「损坏」。 */
  markFailed(sessionId: string, error: string): void {
    this.db.prepare(`INSERT INTO sessions(session_id, title, cwd, created_at, updated_at, message_count, tool_count, indexed_at, error)
      VALUES (?, NULL, NULL, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET error = excluded.error, indexed_at = excluded.indexed_at`)
      .run(sessionId, Date.now(), error)
  }

  /** 读当前索引的全部 session_id → 指纹映射（增量重建 diff 用）。 */
  listFingerprints(): Map<string, string | null> {
    const rows = this.db.prepare('SELECT session_id, log_fingerprint FROM sessions').all() as Array<Record<string, unknown>>
    const map = new Map<string, string | null>()
    for (const row of rows) map.set(String(row.session_id), row.log_fingerprint === null || row.log_fingerprint === undefined ? null : String(row.log_fingerprint))
    return map
  }

  /** 读当前索引的全部 session_id → revision 映射（增量重建快速 diff 用）。 */
  listRevisions(): Map<string, string | null> {
    const rows = this.db.prepare('SELECT session_id, log_revision FROM sessions').all() as Array<Record<string, unknown>>
    const map = new Map<string, string | null>()
    for (const row of rows) map.set(String(row.session_id), row.log_revision === null || row.log_revision === undefined ? null : String(row.log_revision))
    return map
  }

  /** 索引库健康检查：integrity + 关键表存在 + FTS 可查询。 */
  healthCheck(): { healthy: boolean; problems: string[] } {
    const problems: string[] = []
    try {
      const integrity = this.db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
      const ok = integrity.every((row) => String(row.integrity_check) === 'ok')
      if (!ok) problems.push('integrity_check failed')
    } catch (error) {
      problems.push('integrity_check error: ' + (error instanceof Error ? error.message : String(error)))
    }
    try {
      this.db.prepare('SELECT COUNT(*) FROM messages').get()
      this.db.prepare('SELECT COUNT(*) FROM messages_fts').get()
    } catch (error) {
      problems.push('required tables missing/unreadable: ' + (error instanceof Error ? error.message : String(error)))
    }
    return { healthy: problems.length === 0, problems }
  }

  /** 清空全部索引（全量重建前的原子 reset）。 */
  reset(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(`INSERT INTO messages_fts(messages_fts, rowid, text_main, text_tool)
        SELECT 'delete', rowid, text_main, text_tool FROM messages`)
      this.db.exec('DELETE FROM messages')
      this.db.exec('DELETE FROM sessions')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

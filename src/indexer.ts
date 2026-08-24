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
export const DB_USER_VERSION = 1

/** 每会话元数据（同步层传入）。 */
export interface SessionMeta {
  sessionId: string
  title: string | null
  cwd: string | null
  createdAt: number
  updatedAt: number
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
    indexed_at INTEGER NOT NULL
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
        if (userVersion !== DB_USER_VERSION) {
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

      this.db.prepare(`INSERT INTO sessions(session_id, title, cwd, created_at, updated_at, message_count, tool_count, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title, cwd = excluded.cwd, created_at = excluded.created_at,
          updated_at = excluded.updated_at, message_count = excluded.message_count,
          tool_count = excluded.tool_count, indexed_at = excluded.indexed_at`)
        .run(meta.sessionId, meta.title, meta.cwd, meta.createdAt, meta.updatedAt, messages.length, toolCount, now)
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

    const rows = (short
      ? this.db.prepare(`SELECT
          m.session_id, m.seq, m.kind, m.time, m.turn,
          m.text_main, m.text_tool,
          s.title, s.cwd,
          0 AS rank
        FROM messages m
        LEFT JOIN sessions s ON s.session_id = m.session_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.time DESC
        LIMIT ? OFFSET ?`).all(...params, limit + 1, offset)
      : this.db.prepare(`SELECT
          m.session_id, m.seq, m.kind, m.time, m.turn,
          m.text_main, m.text_tool,
          s.title, s.cwd,
          ${RANK} AS rank
        FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        LEFT JOIN sessions s ON s.session_id = m.session_id
        WHERE ${where.join(' AND ')}
        ORDER BY rank, m.time DESC
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
    const indexedRows = this.db.prepare('SELECT session_id, indexed_at FROM sessions').all() as Array<Record<string, unknown>>
    const indexed = new Set(indexedRows.map((row) => String(row.session_id)))
    const stale = knownSessionIds.filter((id) => !indexed.has(id))
    let lastSyncAt: number | null = null
    for (const row of indexedRows) {
      const value = Number(row.indexed_at)
      if (lastSyncAt === null || value > lastSyncAt) lastSyncAt = value
    }
    return {
      totalSessions: knownSessionIds.length,
      indexedSessions: indexedRows.length,
      staleSessions: stale.length,
      failedSessions: 0, // 失败仅在同步日志记录；索引库只保留成功状态
      lastSyncAt,
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
}

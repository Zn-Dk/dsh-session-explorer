import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionIndex, DB_APP_ID, DB_USER_VERSION } from '../src/indexer.js'
import type { IndexableMessage } from '../src/protocol.js'

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-'))
  return path.join(dir, 'test.sqlite')
}

function msg(overrides: Partial<IndexableMessage> = {}): IndexableMessage {
  return {
    sessionId: 's1',
    seq: 1,
    kind: 'user',
    time: 1_700_000_000_000,
    turn: 1,
    textMain: 'hello world',
    textTool: '',
    ...overrides,
  }
}

function meta(overrides: Partial<{ sessionId: string; title: string | null; cwd: string | null; createdAt: number; updatedAt: number }> = {}) {
  return {
    sessionId: 's1',
    title: '重构 indexer',
    cwd: '/root/proj/demo',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  }
}

test('open initializes schema and stamps identity', () => {
  const file = tmpDb()
  const index = SessionIndex.open(file)
  try {
    const mode = fs.statSync(file).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    index.close()
  }
  const raw = fs.readFileSync(file)
  assert.ok(raw.includes('messages_fts'))
})

test('open refuses foreign sqlite file', () => {
  const file = tmpDb()
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE t (x)')
  db.close()
  assert.throws(() => SessionIndex.open(file), /refusing foreign/)
})

test('upsert + search finds messages across fields', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    index.upsertSession(meta(), [
      msg({ seq: 1, kind: 'user', textMain: '帮我重构 session 索引模块' }),
      msg({ seq: 2, kind: 'assistant', textMain: '好的，先跑测试。' }),
      msg({ seq: 3, kind: 'tool', textMain: '', textTool: 'run_code {"file":"indexer.ts"}' }),
      msg({ seq: 4, kind: 'tool', textMain: '', textTool: 'ToolCallError FAILED' }),
    ])
    const main = index.search('重构', { limit: 10 })
    assert.equal(main.items.length, 1)
    assert.equal(main.items[0].seq, 1)
    assert.equal(main.items[0].hitField, 'main')

    const tool = index.search('FAILED', { limit: 10 })
    assert.equal(tool.items.length, 1)
    assert.equal(tool.items[0].hitField, 'tool')

    const none = index.search('不存在的词')
    assert.equal(none.items.length, 0)
  } finally {
    index.close()
  }
})

test('re-indexing a session replaces rows instead of duplicating', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    index.upsertSession(meta(), [msg({ seq: 1, textMain: 'v1 内容' })])
    assert.equal(index.countMessages('s1'), 1)
    index.upsertSession(meta(), [msg({ seq: 1, textMain: 'v2 内容' }), msg({ seq: 2, textMain: '新增' })])
    assert.equal(index.countMessages('s1'), 2)
    assert.equal(index.search('v1', { limit: 10 }).items.length, 0)
    assert.equal(index.search('v2', { limit: 10 }).items.length, 1)
  } finally {
    index.close()
  }
})

test('search filters by kind, time range and cwd', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    index.upsertSession(meta(), [
      msg({ seq: 1, kind: 'user', time: 1_000, textMain: 'alpha' }),
      msg({ seq: 2, kind: 'assistant', time: 2_000, textMain: 'beta alpha' }),
    ])
    index.upsertSession(meta({ sessionId: 's2', cwd: '/other' }), [
      msg({ sessionId: 's2', seq: 1, kind: 'user', time: 1_500, textMain: 'alpha other' }),
    ])

    const byKind = index.search('alpha', { kinds: ['user'], limit: 10 })
    assert.deepEqual(byKind.items.map((m) => m.sessionId + ':' + m.seq), ['s1:1', 's2:1'])

    const byTime = index.search('alpha', { from: 1_400, to: 1_600, limit: 10 })
    assert.deepEqual(byTime.items.map((m) => m.sessionId + ':' + m.seq), ['s2:1'])

    const byCwd = index.search('alpha', { cwd: '/root/proj/demo', limit: 10 })
    assert.deepEqual(byCwd.items.map((m) => m.sessionId + ':' + m.seq), ['s1:1', 's1:2'])
  } finally {
    index.close()
  }
})

test('search paginates with nextOffset', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    index.upsertSession(meta(), [
      msg({ seq: 1, textMain: 'needle one' }),
      msg({ seq: 2, textMain: 'needle two' }),
      msg({ seq: 3, textMain: 'needle three' }),
    ])
    const page1 = index.search('needle', { limit: 2 })
    assert.equal(page1.items.length, 2)
    assert.equal(page1.nextOffset, 2)
    const page2 = index.search('needle', { limit: 2, offset: page1.nextOffset! })
    assert.equal(page2.items.length, 1)
    assert.equal(page2.nextOffset, null)
  } finally {
    index.close()
  }
})

test('timeline returns session summaries ordered by recency', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    index.upsertSession(meta({ sessionId: 'old', updatedAt: 1_000 }), [msg({ sessionId: 'old', seq: 1 })])
    index.upsertSession(meta({ sessionId: 'new', updatedAt: 9_000, title: null }), [msg({ sessionId: 'new', seq: 1 }), msg({ sessionId: 'new', seq: 2 })])
    const nodes = index.timeline()
    assert.deepEqual(nodes.map((n) => n.sessionId), ['new', 'old'])
    assert.equal(nodes[0].title, null)
    assert.equal(nodes[0].messageCount, 2)
    assert.equal(nodes[1].toolCount, 0)
  } finally {
    index.close()
  }
})

test('preview returns focus plus bounded context window', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    const messages = Array.from({ length: 10 }, (_, i) => msg({ seq: i + 1, textMain: 'msg ' + (i + 1) }))
    index.upsertSession(meta(), messages)
    const page = index.preview('s1', 5, { before: 2, after: 2 })
    assert.ok(page)
    assert.equal(page!.focus.seq, 5)
    assert.deepEqual(page!.context.map((m) => m.seq), [3, 4, 6, 7])
    assert.equal(page!.sessionTitle, '重构 indexer')
  } finally {
    index.close()
  }
})

test('preview returns null for unknown session or seq', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    index.upsertSession(meta(), [msg({ seq: 1 })])
    assert.equal(index.preview('s1', 999), null)
    assert.equal(index.preview('nope', 1), null)
  } finally {
    index.close()
  }
})

test('deleteSession removes rows from both tables', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    index.upsertSession(meta(), [msg({ seq: 1, textMain: 'gone soon' })])
    index.deleteSession('s1')
    assert.equal(index.countMessages('s1'), 0)
    assert.equal(index.search('gone', { limit: 10 }).items.length, 0)
    assert.equal(index.timeline().length, 0)
  } finally {
    index.close()
  }
})

test('indexStatus counts stale sessions', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    index.upsertSession(meta(), [msg({ seq: 1 })])
    const status = index.indexStatus(['s1', 's2', 's3'])
    assert.equal(status.totalSessions, 3)
    assert.equal(status.indexedSessions, 1)
    assert.equal(status.staleSessions, 2)
    assert.ok(status.lastSyncAt! > 0)
  } finally {
    index.close()
  }
})

test('sessionMeta reflects latest sync', () => {
  const index = SessionIndex.open(tmpDb())
  try {
    assert.equal(index.sessionMeta('s1'), null)
    index.upsertSession(meta(), [msg({ seq: 1 })])
    const snap = index.sessionMeta('s1')
    assert.ok(snap)
    assert.equal(snap!.messageCount, 1)
  } finally {
    index.close()
  }
})

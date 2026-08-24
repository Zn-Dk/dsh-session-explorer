import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatch, searchRequestSchema, timelineRequestSchema, previewRequestSchema } from '../src/rpc.js'
import type { ExplorerRpc } from '../src/protocol.js'

function fakeHandlers(overrides: Partial<ExplorerRpc> = {}): ExplorerRpc & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {}
  const record = (method: string) => (args: unknown) => {
    calls[method] = calls[method] ?? []
    calls[method].push(args)
    return { echoed: args }
  }
  return {
    search: record('search') as ExplorerRpc['search'],
    timeline: record('timeline') as ExplorerRpc['timeline'],
    preview: record('preview') as ExplorerRpc['preview'],
    indexStatus: record('indexStatus') as ExplorerRpc['indexStatus'],
    rebuild: record('rebuild') as ExplorerRpc['rebuild'],
    ...overrides,
    calls,
  }
}

test('dispatch routes search with valid args', async () => {
  const handlers = fakeHandlers()
  const result = await dispatch(handlers, 'search', { query: '重构', kinds: ['user'], limit: 10 })
  assert.ok(result.ok)
  assert.deepEqual(handlers.calls.search, [{ query: '重构', kinds: ['user'], limit: 10 }])
})

test('dispatch rejects invalid search args', async () => {
  const handlers = fakeHandlers()
  const result = await dispatch(handlers, 'search', { query: '' })
  assert.ok(!result.ok)
  if (!result.ok) assert.equal(result.error.code, 'bad-request')
  assert.equal(handlers.calls.search, undefined)
})

test('dispatch rejects negative limit', async () => {
  const handlers = fakeHandlers()
  const result = await dispatch(handlers, 'search', { query: 'x', limit: -1 })
  assert.ok(!result.ok)
})

test('dispatch rejects unknown kinds', async () => {
  const handlers = fakeHandlers()
  const result = await dispatch(handlers, 'search', { query: 'x', kinds: ['bogus'] })
  assert.ok(!result.ok)
})

test('dispatch routes timeline with empty args', async () => {
  const handlers = fakeHandlers()
  const result = await dispatch(handlers, 'timeline', undefined)
  assert.ok(result.ok)
  assert.deepEqual(handlers.calls.timeline, [{}])
})

test('dispatch routes preview and validates seq', async () => {
  const handlers = fakeHandlers()
  const ok = await dispatch(handlers, 'preview', { sessionId: 's1', seq: 5, before: 2 })
  assert.ok(ok.ok)
  const bad = await dispatch(handlers, 'preview', { sessionId: 's1', seq: -1 })
  assert.ok(!bad.ok)
})

test('dispatch rejects unknown method', async () => {
  const handlers = fakeHandlers()
  const result = await dispatch(handlers, 'nope', {})
  assert.ok(!result.ok)
  if (!result.ok) assert.match(result.error.message, /unknown method/)
})

test('handler exceptions become result packages', async () => {
  const handlers = fakeHandlers({
    search: async () => {
      throw new Error('boom')
    },
  })
  const result = await dispatch(handlers, 'search', { query: 'x' })
  assert.ok(!result.ok)
  if (!result.ok) assert.match(result.error.message, /boom/)
})

test('schema bounds: limit capped at 200, preview window at 50', () => {
  assert.ok(searchRequestSchema.safeParse({ query: 'x', limit: 200 }).success)
  assert.ok(!searchRequestSchema.safeParse({ query: 'x', limit: 201 }).success)
  assert.ok(previewRequestSchema.safeParse({ sessionId: 's', seq: 1, before: 50 }).success)
  assert.ok(!previewRequestSchema.safeParse({ sessionId: 's', seq: 1, before: 51 }).success)
  assert.ok(timelineRequestSchema.safeParse({ limit: 1000 }).success)
  assert.ok(!timelineRequestSchema.safeParse({ limit: 1001 }).success)
})

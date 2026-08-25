import test from 'node:test'
import assert from 'node:assert/strict'
import { foldSession, foldTitle, textOf, makeSnippet, TOOL_TEXT_MAX } from '../src/transcript.js'

const text = (t: string) => [{ type: 'text', text: t }]

function event(type: string, seq: number, data: unknown = {}, extra: Record<string, unknown> = {}) {
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...extra }
}

test('folds user/assistant/tool messages with turn tracking', () => {
  const events = [
    event('turn/start', 1, { turn: 1 }),
    event('user/message', 2, { source: { kind: 'user' }, content: text('帮我重构 indexer') }),
    event('assistant/message', 3, { turn: 1, step: 0, message: { source: { kind: 'model' }, content: text('好的，先看文件。') } }),
    event('tool/call', 4, { turn: 1, step: 0, callId: 'c1', name: 'run_code', arguments: '{"x":1}' }),
    event('tool/result', 5, { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1' }] } }),
    event('assistant/message', 6, { turn: 1, step: 1, message: { source: { kind: 'model' }, content: text('重构完成。') } }),
    event('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const result = foldSession('s1', events)
  assert.equal(result.messages.length, 5)
  assert.deepEqual(result.messages.map((m) => m.kind), ['user', 'assistant', 'tool', 'tool', 'assistant'])
  assert.equal(result.messages[0].turn, 1)
  assert.equal(result.messages[2].turn, 1)
  const toolCall = result.messages[2]
  assert.equal(toolCall.textMain, '')
  assert.equal(toolCall.textTool, 'run_code {"x":1}')
  const toolResult = result.messages[3]
  assert.equal(toolResult.textTool, '') // 无错误结果不进低权重字段
  assert.equal(result.stats.messageCount, 5)
  assert.equal(result.stats.toolCount, 2)
})

test('classifies plugin-injected user messages as steering', () => {
  const events = [
    event('user/message', 1, { source: { kind: 'plugin', plugin: 'goal' }, content: text('goal continuation') }),
  ]
  const result = foldSession('s1', events)
  assert.equal(result.messages[0].kind, 'steering')
  assert.equal(result.messages[0].textMain, 'goal continuation')
})

test('classifies non-user sources (skill-catalog/skill-invocation) as steering with text', () => {
  const events = [
    event('user/message', 1, { source: { kind: 'skill-catalog' }, content: text('available skills…') }),
    event('user/message', 2, { source: { kind: 'skill-invocation' }, content: text('skill invoked') }),
    event('user/message', 3, { source: { kind: 'user' }, content: text('真实用户输入') }),
  ]
  const result = foldSession('s1', events)
  assert.deepEqual(result.messages.map((m) => m.kind), ['steering', 'steering', 'user'])
  assert.equal(result.messages[0].textMain, 'available skills…')
  assert.equal(result.messages[2].textMain, '真实用户输入')
})

test('compaction summary becomes a steering entry', () => {
  const events = [
    event('compaction/summary', 10, {
      summary: text('前期讨论了重构计划。'),
      shadowedRange: { start: 2, end: 8 },
    }),
  ]
  const result = foldSession('s1', events)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].kind, 'steering')
  assert.equal(result.messages[0].textMain, '前期讨论了重构计划。')
  assert.match(result.messages[0].textTool, /shadowed 2\.\.8/)
})

test('tool result error lands in low-weight field', () => {
  const events = [
    event('tool/call', 1, { callId: 'c1', name: 'run_code', arguments: '' }),
    event('tool/result', 2, {
      callId: 'c1',
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
      error: { name: 'ToolCallError', code: 'FAILED' },
    }),
  ]
  const result = foldSession('s1', events)
  const toolResult = result.messages[1]
  assert.equal(toolResult.textTool, 'ToolCallError FAILED')
})

test('chunks, boundaries and log-only events produce no entries', () => {
  const events = [
    event('session', 1, { id: 's1' }),
    event('turn/start', 2, { turn: 1 }),
    event('step/start', 3, { turn: 1, step: 0 }),
    event('assistant/chunk', 4, { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'abc' } }),
    event('todo/write', 5, { todos: [] }),
    event('request/header', 6, { header: {} }),
    event('step/end', 7, { turn: 1, step: 0 }),
    event('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const result = foldSession('s1', events)
  assert.equal(result.messages.length, 0)
})

test('turn carries over when user/message lacks its own turn', () => {
  const events = [
    event('turn/start', 1, { turn: 3 }),
    event('user/message', 2, { source: { kind: 'user' }, content: text('hi') }),
  ]
  const result = foldSession('s1', events)
  assert.equal(result.messages[0].turn, 3)
})

test('missing seq events are skipped', () => {
  const events = [
    event('user/message', 1, { source: { kind: 'user' }, content: text('a') }),
    { type: 'assistant/message', time: 123, data: { turn: 1, message: { source: { kind: 'model' }, content: text('no seq') } } },
  ]
  const result = foldSession('s1', events)
  assert.equal(result.messages.length, 1)
})

test('textOf extracts text blocks only', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }, { type: 'tool-call', name: 'x' }]), 'a')
  assert.equal(textOf('not array'), '')
  assert.equal(textOf([{ type: 'text', text: 'l1' }, { type: 'text', text: 'l2' }]), 'l1' + '\n' + 'l2')
})

test('clamps long tool text', () => {
  const longArgs = 'x'.repeat(TOOL_TEXT_MAX + 100)
  const events = [event('tool/call', 1, { callId: 'c1', name: 'run_code', arguments: longArgs })]
  const result = foldSession('s1', events)
  assert.ok(result.messages[0].textTool.length <= TOOL_TEXT_MAX + 1)
  assert.ok(result.messages[0].textTool.endsWith('…'))
})

test('makeSnippet highlights match with ellipses', () => {
  const body = 'a'.repeat(80) + 'FINDME' + 'b'.repeat(80)
  const snippet = makeSnippet(body, 'findme', 20)
  assert.ok(snippet.includes('FINDME'))
  assert.ok(snippet.startsWith('…'))
  assert.ok(snippet.endsWith('…'))
})

test('foldTitle returns the latest session/title', () => {
  const events = [
    event('session/title', 1, { title: '第一个标题' }),
    event('user/message', 2, { source: { kind: 'user' }, content: text('hi') }),
    event('session/title', 3, { title: '最终标题' }),
  ]
  assert.equal(foldTitle(events), '最终标题')
})

test('foldTitle returns null without title events', () => {
  assert.equal(foldTitle([event('user/message', 1, { source: { kind: 'user' }, content: text('hi') })]), null)
})

test('makeSnippet returns plain prefix when no match', () => {
  const body = 'a'.repeat(200)
  const snippet = makeSnippet(body, 'zzz', 20)
  assert.ok(snippet.endsWith('…'))
  assert.ok(!snippet.startsWith('…'))
})

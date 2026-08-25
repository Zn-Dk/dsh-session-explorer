/**
 * transcript.ts —— SessionEvent 日志 → 可索引消息条目的纯折叠层。
 *
 * 输入是结构化的 SessionEvent 数组（字段形状按 engine 的 SessionEventMap，
 * 但用本地结构化类型，不 import engine —— 保持零依赖、可单测）。
 *
 * 折叠规则（MVP 范围）：
 * - 'user/message'    → kind 'user'；source.kind === 'plugin' → 'steering'
 * - 'assistant/message' → kind 'assistant'，正文=text blocks
 * - 'tool/call'       → kind 'tool'，textTool=name+arguments（低权重字段）
 * - 'tool/result'     → kind 'tool'，textTool=错误摘要（isError/error）；正文不进索引（V2）
 * - 'compaction/summary' → kind 'steering'，textMain=摘要正文（折叠区间可检索）
 * - 'compaction/checkpoint'（replace 语义的 user/message）→ 'steering'
 * - assistant/chunk、边界事件、todo/request 等 → 跳过（不产生条目）
 */

/** 本地结构化事件（松散容忍未知字段）。 */
interface RawEvent {
  type?: string
  seq?: number
  time?: number
  data?: {
    turn?: number
    step?: number
    callId?: string
    name?: string
    arguments?: string
    error?: { name?: string; code?: string }
    summary?: unknown
    shadowedRange?: { start: number; end: number }
    /** user/message 的 message 内容在 data 顶层（source/content/role）。 */
    role?: string
    source?: { kind?: string; plugin?: string }
    content?: Array<{
      type?: string
      text?: string
      toolCallId?: string
      isError?: boolean
    }>
    /** assistant/message 与 tool/result 的 message 包裹在 data.message 内。 */
    message?: {
      role?: string
      source?: { kind?: string; plugin?: string }
      content?: Array<{
        type?: string
        text?: string
        toolCallId?: string
        isError?: boolean
      }>
    }
    [key: string]: unknown
  }
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
}

import type { IndexableMessage, MessageKind } from './protocol.js'

/** textTool 上限：超长参数/错误摘要截断，避免索引行膨胀。 */
export const TOOL_TEXT_MAX = 2000

/** 从 content blocks 提取纯文本（type==='text'），用换行连接。 */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** 从 compaction/summary 的 summary blocks 提取文本。 */
function summaryTextOf(summary: unknown): string {
  return textOf(summary)
}

function clampToolText(text: string): string {
  if (text.length <= TOOL_TEXT_MAX) return text
  return text.slice(0, TOOL_TEXT_MAX) + '…'
}

/** 单会话折叠结果。 */
export interface FoldResult {
  messages: IndexableMessage[]
  /** 会话级统计（timeline 节点用）。 */
  stats: { messageCount: number; toolCount: number; firstTime: number | null; lastTime: number | null }
}

/**
 * 把一条会话日志折叠成可索引条目。
 * @param sessionId 会话 id（来自 header）。
 * @param events 事件数组（通常按 seq 升序，但折叠不依赖顺序——只依赖 turn 传递）。
 */
export function foldSession(sessionId: string, events: RawEvent[]): FoldResult {
  const messages: IndexableMessage[] = []
  let turn: number | null = null
  let lastTime: number | null = null
  let toolCount = 0
  let messageCount = 0

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const seq = event.seq
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue
    const time: number = typeof event.time === 'number' ? event.time : (lastTime ?? 0)
    lastTime = time
    const type = event.type
    const data = event.data ?? {}
    if (typeof data.turn === 'number') turn = data.turn

    if (type === 'turn/start') {
      turn = data.turn ?? null
      continue
    }

    let kind: MessageKind | null = null
    let textMain = ''
    let textTool = ''

    if (type === 'user/message') {
      // user/message 的 message 就在 data 顶层（data.source / data.content），不是 data.message。
      // 分类语义（对齐 harness ui-conversation message.ts）：
      //   source.kind === 'user' → 用户消息；
      //   其余（plugin / skill-catalog / skill-invocation / …）→ 系统注入（steering）。
      const sourceKind = data.source?.kind
      kind = sourceKind === 'user' ? 'user' : 'steering'
      textMain = textOf(data.content)
    } else if (type === 'assistant/message') {
      kind = 'assistant'
      textMain = textOf(data.message?.content)
    } else if (type === 'tool/call') {
      kind = 'tool'
      const name = typeof data.name === 'string' ? data.name : ''
      const args = typeof data.arguments === 'string' ? data.arguments : ''
      textTool = clampToolText([name, args].filter(Boolean).join(' '))
      toolCount++
    } else if (type === 'tool/result') {
      kind = 'tool'
      const isError = data.message?.content?.some((block) => block.isError === true) === true
      const error = data.error
      if (isError || error) {
        const name = error?.name ?? ''
        const code = error?.code ?? ''
        textTool = clampToolText([name, code].filter(Boolean).join(' '))
      }
      toolCount++
    } else if (type === 'compaction/summary') {
      kind = 'steering'
      textMain = summaryTextOf(data.summary)
      const range = data.shadowedRange
      textTool = range ? `compaction shadowed ${range.start}..${range.end}` : 'compaction'
    }

    if (kind === null) continue

    messages.push({
      sessionId,
      seq,
      kind,
      time,
      turn,
      textMain,
      textTool,
    })
    messageCount++
  }

  return {
    messages,
    stats: {
      messageCount,
      toolCount,
      firstTime: messages.length ? Math.min(...messages.map((m) => m.time)) : null,
      lastTime: messages.length ? Math.max(...messages.map((m) => m.time)) : null,
    },
  }
}

/** 折叠日志中最后一个 session/title 事件（latest-wins）。 */
export function foldTitle(events: RawEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title) {
      return event.data.title
    }
  }
  return null
}

/** 检索片段：围绕命中词截取上下文窗口。 */
export function makeSnippet(text: string, query: string, radius = 60): string {
  const source = text.trim()
  if (!source) return ''
  const lower = source.toLowerCase()
  const q = query.toLowerCase().trim()
  const idx = q ? lower.indexOf(q) : -1
  if (idx < 0) return source.length <= 160 ? source : source.slice(0, radius) + '…'
  const start = Math.max(0, idx - radius)
  const end = Math.min(source.length, idx + q.length + radius)
  return (start > 0 ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '')
}

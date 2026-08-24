/**
 * client/views/PreviewView.tsx —— 只读消息预览（焦点消息 + 上下文窗口）。
 */

import { useState, useEffect, useCallback } from 'react'
import { envelopeError, type ExplorerClient } from '../store.js'
import type { IndexableMessage, PreviewPage } from '../../protocol.js'

export interface PreviewViewProps {
  client: ExplorerClient
  sessionId: string
  seq: number
  onBack: () => void
  onOpenSession: (sessionId: string) => void
}

const KIND_LABELS: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  steering: '系统注入',
}

const KIND_COLORS: Record<string, string> = {
  user: '#3b82f6',
  assistant: '#10b981',
  tool: '#f59e0b',
  steering: '#8b5cf6',
}

function formatTime(time: number): string {
  return new Date(time).toLocaleString()
}

function MessageRow({ message, focused }: { message: IndexableMessage; focused: boolean }) {
  const isUser = message.kind === 'user'
  const isTool = message.kind === 'tool'
  const label = KIND_LABELS[message.kind] ?? message.kind
  const color = KIND_COLORS[message.kind] ?? '#888'
  const text = message.textMain || message.textTool || '(无内容)'
  return (
    <div className={'sex-msg' + (focused ? ' sex-msg-focus' : '') + (isUser ? ' sex-msg-user' : '')}>
      <div className="sex-msg-head">
        <span className="sex-msg-kind" style={{ color }}>{label}</span>
        <span className="sex-msg-meta">
          {message.turn != null ? 'turn ' + message.turn + ' · ' : ''}
          {formatTime(message.time)}
          {focused ? ' · 命中' : ''}
        </span>
      </div>
      <div className="sex-msg-body">{text}</div>
    </div>
  )
}

export function PreviewView({ client, sessionId, seq, onBack, onOpenSession }: PreviewViewProps) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; page: PreviewPage | null; error: string | null }>({ status: 'loading', page: null, error: null })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await client.preview(sessionId, seq, 20, 20)
        if (cancelled) return
        if (!res.ok) {
          setState({ status: 'error', page: null, error: envelopeError(res) || 'preview failed' })
          return
        }
        setState({ status: 'ready', page: res.value ?? null, error: null })
      } catch (error) {
        if (!cancelled) setState({ status: 'error', page: null, error: String(error) })
      }
    })()
    return () => { cancelled = true }
  }, [client, sessionId, seq])

  if (state.status === 'loading') return <div className="sex-empty">加载预览…</div>
  if (state.status === 'error') return <div className="sex-error">{state.error}</div>
  const page = state.page
  if (!page) return <div className="sex-empty">该消息已不在索引中（会话可能已重建）。</div>

  const focusSeq = page.focus.seq
  const before = page.context.filter((m) => m.seq < focusSeq)
  const after = page.context.filter((m) => m.seq > focusSeq)

  return (
    <div className="sex-preview">
      <div className="sex-preview-bar">
        <button type="button" className="sex-mini-btn" onClick={onBack}>← 返回</button>
        <div className="sex-preview-title">
          <span className="sex-hit-title">{page.sessionTitle ?? '(无标题)'}</span>
          <span className="sex-hit-meta">{page.cwd ?? ''}</span>
        </div>
        <button type="button" className="sex-mini-btn" onClick={() => { onOpenSession(sessionId) }}>打开会话</button>
      </div>
      <div className="sex-preview-scroll">
        {before.map((message) => <MessageRow key={message.seq} message={message} focused={false} />)}
        <MessageRow message={page.focus} focused />
        {after.map((message) => <MessageRow key={message.seq} message={message} focused={false} />)}
      </div>
    </div>
  )
}

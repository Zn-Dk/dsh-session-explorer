/**
 * client/views/SearchView.tsx —— 消息级全文检索视图。
 * MVP：搜索用户/助手消息 + 工具名/参数/错误摘要（低权重）。
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ExplorerClient } from '../store.js'
import type { MessageHit, MessageKind, SearchResponse } from '../../protocol.js'

export interface SearchViewProps {
  client: ExplorerClient
  /** 点击结果 → 预览。 */
  onPreview: (hit: MessageHit) => void
  /** 打开会话（跳到真实会话）。 */
  onOpenSession: (sessionId: string) => void
}

const KIND_LABELS: Array<{ kind: MessageKind; label: string }> = [
  { kind: 'user', label: '用户' },
  { kind: 'assistant', label: '助手' },
  { kind: 'tool', label: '工具' },
  { kind: 'steering', label: '系统注入' },
]

const KIND_COLORS: Record<MessageKind, string> = {
  user: '#3b82f6',
  assistant: '#10b981',
  tool: '#f59e0b',
  steering: '#8b5cf6',
}

function formatTime(time: number): string {
  const date = new Date(time)
  return date.toLocaleString()
}

export function SearchView({ client, onPreview, onOpenSession }: SearchViewProps) {
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<MessageKind[]>([])
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; items: MessageHit[]; nextOffset: number | null | undefined; error: string | null }>({ status: 'idle', items: [], nextOffset: undefined, error: null })
  const abortRef = useRef<AbortController | null>(null)

  const doSearch = useCallback(async (offset: number) => {
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState({ status: 'loading', items: offset === 0 ? [] : state.items, nextOffset: undefined, error: null })
    try {
      const res = await client.search({ query, kinds: kinds.length ? kinds : undefined, limit: 50, offset })
      if (controller.signal.aborted) return
      if (!res.ok) {
        setState({ status: 'error', items: [], nextOffset: undefined, error: res.message ?? 'search failed' })
        return
      }
      const value = res.value ?? { items: [], nextOffset: undefined }
      setState({
        status: 'ready',
        items: offset === 0 ? value.items : [...state.items, ...value.items],
        nextOffset: value.nextOffset ?? null,
        error: null,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      setState({ status: 'error', items: [], nextOffset: undefined, error: String(error) })
    }
  }, [client, query, kinds, state.items])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setState({ status: 'idle', items: [], nextOffset: undefined, error: null })
      return
    }
    const timer = window.setTimeout(() => { void doSearch(0) }, 300)
    return () => {
      window.clearTimeout(timer)
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, kinds])

  const toggleKind = (kind: MessageKind) => {
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  }

  const loadMore = () => {
    if (state.nextOffset != null) void doSearch(state.nextOffset)
  }

  return (
    <div className="sex-search">
      <div className="sex-search-bar">
        <input
          className="sex-input"
          type="search"
          placeholder="搜索会话消息（正文 / 工具名 / 参数 / 错误摘要）…"
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>
      <div className="sex-kind-row">
        {KIND_LABELS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            className={'sex-kind-chip' + (kinds.includes(kind) ? ' sex-kind-on' : '')}
            onClick={() => { toggleKind(kind) }}
          >
            <span className="sex-kind-dot" style={{ background: KIND_COLORS[kind] }} />
            {label}
          </button>
        ))}
      </div>
      {state.status === 'idle' && <div className="sex-empty">输入关键词开始检索</div>}
      {state.status === 'loading' && <div className="sex-empty">检索中…</div>}
      {state.status === 'error' && <div className="sex-error">{state.error}</div>}
      {state.status === 'ready' && state.items.length === 0 && <div className="sex-empty">没有匹配的消息</div>}
      {state.items.length > 0 && (
        <div className="sex-results">
          {state.items.map((item) => (
            <div key={item.sessionId + ':' + item.seq} className="sex-hit" onClick={() => { onPreview(item) }}>
              <div className="sex-hit-head">
                <span className="sex-hit-kind" style={{ color: KIND_COLORS[item.kind] }}>
                  {KIND_LABELS.find((k) => k.kind === item.kind)?.label ?? item.kind}
                </span>
                <span className="sex-hit-title">{item.sessionTitle ?? '(无标题)'}</span>
                <span className="sex-hit-meta">{formatTime(item.time)}</span>
              </div>
              <div className="sex-hit-snippet">{item.snippet}</div>
              <div className="sex-hit-foot">
                <span className="sex-hit-cwd">{item.cwd ?? ''}</span>
                <button
                  type="button"
                  className="sex-mini-btn"
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenSession(item.sessionId)
                  }}
                >
                  打开会话
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {state.nextOffset != null && (
        <div className="sex-more">
          <button type="button" className="sex-mini-btn" onClick={loadMore}>加载更多</button>
        </div>
      )}
    </div>
  )
}

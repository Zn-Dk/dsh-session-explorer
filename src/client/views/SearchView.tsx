/**
 * client/views/SearchView.tsx —— 消息级全文检索视图。
 * MVP：搜索用户/助手消息 + 工具名/参数/错误摘要（低权重）。
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { envelopeError, type ExplorerClient } from '../store.js'
import type { MessageHit, MessageKind, SearchResponse } from '../../protocol.js'
import { useI18n, type I18nKey } from '../i18n.js'

export interface SearchViewProps {
  client: ExplorerClient
  /** 点击结果 → 预览。 */
  onPreview: (hit: MessageHit) => void
  /** 打开会话（跳到真实会话）。 */
  onOpenSession: (sessionId: string) => void
  /** DSH Host locale 服务（缺省回退 navigator.language）。 */
  locale?: import('../i18n.js').LocaleServiceLike
}

const KIND_KEYS: Array<{ kind: MessageKind; key: I18nKey }> = [
  { kind: 'user', key: 'kindUser' },
  { kind: 'assistant', key: 'kindAssistant' },
  { kind: 'tool', key: 'kindTool' },
  { kind: 'steering', key: 'kindSteering' },
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

export function SearchView({ client, onPreview, onOpenSession, locale }: SearchViewProps) {
  const { t } = useI18n(locale)
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
        setState({ status: 'error', items: [], nextOffset: undefined, error: envelopeError(res) || t('searchFailed') })
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
  }, [client, query, kinds, state.items, t])

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
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>
      <div className="sex-kind-row">
        {KIND_KEYS.map(({ kind, key }) => (
          <button
            key={kind}
            type="button"
            className={'sex-kind-chip' + (kinds.includes(kind) ? ' sex-kind-on' : '')}
            onClick={() => { toggleKind(kind) }}
          >
            <span className="sex-kind-dot" style={{ background: KIND_COLORS[kind] }} />
            {t(key)}
          </button>
        ))}
      </div>
      {state.status === 'idle' && <div className="sex-empty">{t('searchIdle')}</div>}
      {state.status === 'loading' && <div className="sex-empty">{t('searchLoading')}</div>}
      {state.status === 'error' && <div className="sex-error">{state.error}</div>}
      {state.status === 'ready' && state.items.length === 0 && <div className="sex-empty">{t('searchNoResult')}</div>}
      {state.items.length > 0 && (
        <div className="sex-results">
          {state.items.map((item) => (
            <div key={item.sessionId + ':' + item.seq} className="sex-hit" onClick={() => { onPreview(item) }}>
              <div className="sex-hit-head">
                <span className="sex-hit-kind" style={{ color: KIND_COLORS[item.kind] }}>
                  {KIND_KEYS.find((k) => k.kind === item.kind) ? t(KIND_KEYS.find((k) => k.kind === item.kind)!.key) : item.kind}
                </span>
                <span className="sex-hit-title">{item.sessionTitle ?? t('noTitle')}</span>
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
                  {t('openSession')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {state.nextOffset != null && (
        <div className="sex-more">
          <button type="button" className="sex-mini-btn" onClick={loadMore}>{t('loadMore')}</button>
        </div>
      )}
    </div>
  )
}

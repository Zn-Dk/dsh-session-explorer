/**
 * Timeline overview: searchable session grid + in-place message summary detail.
 * This intentionally does not jump to the original conversation: the host has
 * no stable anchor API yet, so the plugin must remain useful on its own.
 */
import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import type { MessageKind, TimelineNode, TimelineTurnsResponse, TimelineNodeKind, MessageHit } from '../../protocol.js'
import { useI18n, type LocaleServiceLike } from '../i18n.js'
import { envelopeError, type ExplorerClient } from '../store.js'

export interface TimelineViewProps {
  client: ExplorerClient
  nodes: TimelineNode[]
  selectedSessionId: string | null
  turns: { status: 'idle' | 'loading' | 'ready' | 'error'; data: TimelineTurnsResponse | null; error: string | null }
  onSelectSession: (sessionId: string) => void
  onDrillTurn: (sessionId: string) => void
  onPreview: (sessionId: string, seq: number | null) => void
  locale?: LocaleServiceLike
}

const KIND_OPTIONS: Array<{ value: TimelineNodeKind | 'all'; key: 'timelineAll' | 'timelineMain' | 'timelineChild' }> = [
  { value: 'all', key: 'timelineAll' }, { value: 'main', key: 'timelineMain' }, { value: 'child', key: 'timelineChild' },
]

/** 与消息检索 SearchView 的 KIND_COLORS 完全一致。 */
const KIND_COLORS: Record<MessageKind, string> = {
  user: '#3b82f6',
  assistant: '#10b981',
  tool: '#f59e0b',
  steering: '#8b5cf6',
}

type SortKey = 'updated' | 'created' | 'messages'
type SortDir = 'asc' | 'desc'

const formatTime = (value: number): string => new Date(value).toLocaleString()
const kindLabel = (kind: string, t: (key: never) => string): string => kind === 'user' ? t('kindUser' as never) : kind === 'assistant' ? t('kindAssistant' as never) : kind === 'steering' ? t('kindSteering' as never) : t('kindTool' as never)
const shortCwd = (value: string | null): string => value ? (value.split(/[\/]/).filter(Boolean).pop() ?? value) : ''

/** 分钟级时间：YYYY-MM-DD HH:MM（滚动时间锚点用）。 */
function fmtMinute(time: number): string {
  const d = new Date(time)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return y + '-' + m + '-' + day + ' ' + h + ':' + min
}

export function TimelineView({ client, nodes, selectedSessionId, turns, onSelectSession, onDrillTurn, onPreview, locale }: TimelineViewProps) {
  const { t } = useI18n(locale)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<TimelineNodeKind | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('updated')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [wsOpen, setWsOpen] = useState(false)
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null)
  const [hits, setHits] = useState<MessageHit[]>([])
  const [hitSearchActive, setHitSearchActive] = useState(false)
  const [scrollTime, setScrollTime] = useState<string>('')
  const detailRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 会话切换时重置消息展开态（旧会话的 seq 在新会话里可能指向别的消息）
  useEffect(() => { setExpandedSeq(null) }, [selectedSessionId])

  const selected = selectedSessionId === null || selectedSessionId === '' ? null : nodes.find(n => n.sessionId === selectedSessionId) ?? null

  // 工作区选项：从节点派生（去重 + 按会话数排序）
  const workspaceOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of nodes) {
      const key = n.cwd ?? ''
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cwd, count]) => ({ cwd, count }))
  }, [nodes])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const wsSet = new Set(workspaces)
    const dir = sortDir === 'asc' ? 1 : -1
    return nodes.filter(n => {
      if (kind !== 'all' && n.kind !== kind) return false
      if (wsSet.size > 0 && !wsSet.has(n.cwd ?? '')) return false
      if (!q) return true
      const hay = [n.title, n.cwd, n.sessionId, n.firstMessage?.text, n.latestMessage?.text].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    }).sort((a, b) => dir * (sortKey === 'created' ? a.createdAt - b.createdAt : sortKey === 'messages' ? a.messageCount - b.messageCount : a.updatedAt - b.updatedAt))
  }, [nodes, query, kind, workspaces, sortKey, sortDir])

  // 选中会话在可见列表中的索引 + 上一条/下一条（纯客户端，按当前筛选/排序后的可见列表走）
  const selectedIndex = selected ? visible.findIndex(n => n.sessionId === selected.sessionId) : -1
  const goPrevSession = useCallback(() => {
    if (selectedIndex <= 0) return
    const prev = visible[selectedIndex - 1]
    if (prev) onSelectSession(prev.sessionId)
  }, [visible, selectedIndex, onSelectSession])
  const goNextSession = useCallback(() => {
    if (selectedIndex < 0 || selectedIndex >= visible.length - 1) return
    const next = visible[selectedIndex + 1]
    if (next) onSelectSession(next.sessionId)
  }, [visible, selectedIndex, onSelectSession])

  const applyQuery = useCallback((value: string) => { setQuery(value) }, [])
  const applyKind = useCallback((value: TimelineNodeKind | 'all') => { setKind(value) }, [])
  const applySortKey = useCallback((value: SortKey) => { setSortKey(value) }, [])
  const applySortDir = useCallback(() => { setSortDir(d => d === 'asc' ? 'desc' : 'asc') }, [])

  // 正文全文检索：复用 search RPC，跨会话搜消息正文；命中结果用于卡片 badge + 定位跳转
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setHits([])
      setHitSearchActive(false)
      return
    }
    setHitSearchActive(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await client.search({ query: trimmed, limit: 100 })
          if (!res.ok) { setHits([]); setHitSearchActive(false); return }
          setHits(res.value?.items ?? [])
          setHitSearchActive(false)
        } catch { setHits([]); setHitSearchActive(false) }
      })()
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, client])

  // 滚动时间锚点：监听 aside（滚动容器）滚动，计算可视区顶部第一条消息的时间
  useEffect(() => {
    const el = detailRef.current
    if (!el || turns.status !== 'ready') return
    const update = () => {
      const items = el.querySelectorAll<HTMLElement>('[data-mtime]')
      const top = el.getBoundingClientRect().top
      let time: number | null = null
      for (const item of items) {
        const r = item.getBoundingClientRect()
        if (r.bottom > top) { time = Number(item.dataset.mtime); break }
      }
      setScrollTime(time != null && !Number.isNaN(time) ? fmtMinute(time) : '')
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      el.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [turns.status, turns.data])

  const toggleWorkspace = useCallback((cwd: string) => {
    setWorkspaces(list => list.includes(cwd) ? list.filter(x => x !== cwd) : [...list, cwd])
  }, [])

  if (nodes.length === 0) return <div className="sex-empty">{t('timelineEmpty')}</div>
  return <div className="sex-timeline-overview">
    <div className="sex-timeline-toolbar">
      <input className="sex-input sex-timeline-search" value={query} placeholder={t('timelineSearchPlaceholder')} onChange={e => applyQuery(e.target.value)} />
      {hitSearchActive && <span className="sex-timeline-search-status">{t('searchLoading')}</span>}
      {!hitSearchActive && hits.length > 0 && <span className="sex-timeline-search-status sex-timeline-search-status-hits" title={t('timelineHitJumpAria')}>{t('timelineVisibleCount', { n: String(hits.length) })} 命中</span>}
      <div className="sex-timeline-filters">
        {KIND_OPTIONS.map(option => <button key={option.value} type="button" className={'sex-filter-chip' + (kind === option.value ? ' sex-filter-chip-on' : '')} onClick={() => applyKind(option.value)}>{t(option.key)}</button>)}
      </div>
      <div className={'sex-ws-select' + (wsOpen ? ' sex-ws-select-open' : '')}>
        <button type="button" className="sex-ws-select-toggle" onClick={() => { setWsOpen(v => !v) }}>
          {workspaces.length === 0 ? t('timelineWorkspaceAll') : t('timelineWorkspaceSelected', { n: String(workspaces.length) })}
          <span aria-hidden="true">▾</span>
        </button>
        {wsOpen && (
          <>
            <div className="sex-ws-select-backdrop" onClick={() => { setWsOpen(false) }} />
            <div className="sex-ws-select-list">
              {workspaceOptions.map(option => (
                <label key={option.cwd} className="sex-ws-option">
                  <input type="checkbox" checked={workspaces.includes(option.cwd)} onChange={() => { toggleWorkspace(option.cwd) }} />
                  <span className="sex-ws-option-label">{shortCwd(option.cwd) || t('timelineUnknownDir')}</span>
                  <span className="sex-ws-option-count">{option.count}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>
      <select className="sex-timeline-sort" value={sortKey} aria-label={t('timelineSort')} onChange={e => applySortKey(e.target.value as SortKey)}>
        <option value="updated">{t('timelineSortUpdated')}</option>
        <option value="created">{t('timelineSortCreated')}</option>
        <option value="messages">{t('timelineSortMessages')}</option>
      </select>
      <button type="button" className="sex-filter-chip" aria-label={t('timelineSortDir')} title={t('timelineSortDir')} onClick={() => { applySortDir() }}>{sortDir === 'asc' ? '↑' : '↓'}</button>
      <span className="sex-timeline-count">{t('timelineVisibleCount', { n: String(visible.length) })}</span>
    </div>
    <div className={'sex-timeline-main' + (selected ? ' sex-timeline-main-split' : '')}>
      <div className="sex-session-grid">
        {visible.map((node, index) => {
          const nodeHits = hits.filter(h => h.sessionId === node.sessionId)
          return (
          <button key={node.sessionId} type="button" style={{ animationDelay: Math.min(index * 14, 240) + 'ms' }} className={'sex-session-card sex-session-card-' + node.kind + (selected !== null && selectedSessionId === node.sessionId ? ' sex-session-card-selected' : '')} onClick={() => { onSelectSession(selectedSessionId === node.sessionId ? '' : node.sessionId) }}>
          <div className="sex-session-card-head"><strong>{node.title ?? node.sessionId.slice(0, 12)}</strong>{nodeHits.length > 0 && <span className="sex-card-hit-badge" title={t('timelineHitJumpAria')} aria-label={t('timelineHitJumpAria')}>{nodeHits.length}</span>}<span className={'sex-kind-badge sex-kind-badge-' + node.kind}>{t(node.kind === 'child' ? 'timelineChild' : 'timelineMain')}</span></div>
          <div className="sex-session-card-meta">{shortCwd(node.cwd) || t('timelineUnknownDir')} · {formatTime(node.updatedAt)}</div>
          <div className="sex-session-card-stats">{t('timelineMessages', { n: String(node.messageCount) })} · {t('timelineTools', { n: String(node.toolCount) })}</div>
          <div className="sex-session-card-summary">{node.latestMessage?.text || node.firstMessage?.text || t('timelineNoSummary')}</div>
          </button>
          )
        })}
      </div>
      {selected && <aside key={selected.sessionId} ref={detailRef} className="sex-session-detail">
        <div className="sex-session-detail-nav">
          <button type="button" className="sex-detail-nav-btn" disabled={selectedIndex <= 0} onClick={goPrevSession} aria-label={t('timelinePrevSession')} title={t('timelinePrevSession')}><span aria-hidden="true">‹</span> {t('timelinePrevSession')}</button>
          <span className="sex-detail-nav-position">{String(selectedIndex + 1)} / {String(visible.length)}</span>
          <button type="button" className="sex-detail-nav-btn" disabled={selectedIndex < 0 || selectedIndex >= visible.length - 1} onClick={goNextSession} aria-label={t('timelineNextSession')} title={t('timelineNextSession')}>{t('timelineNextSession')} <span aria-hidden="true">›</span></button>
        </div>
        <div className="sex-session-detail-head"><div><h3>{selected.title ?? selected.sessionId}</h3><div className="sex-session-detail-meta">{shortCwd(selected.cwd) || t('timelineUnknownDir')} · {formatTime(selected.createdAt)} → {formatTime(selected.updatedAt)}</div></div><span className={'sex-kind-badge sex-kind-badge-' + selected.kind}>{t(selected.kind === 'child' ? 'timelineChild' : 'timelineMain')}</span></div>
        <div className="sex-session-detail-lineage">{t('timelineLineage')}: {selected.parentSessionId ? selected.parentSessionId.slice(0, 12) : t('timelineRootSession')}</div>
        <div key={selected.sessionId} ref={listRef} className="sex-message-summary-list">
          <div className="sex-scroll-time-anchor" aria-hidden="true">{scrollTime}</div>
          {turns.status === 'loading' && (
            <div className="sex-summary-skeleton" aria-hidden="true">
              <div className="sex-skeleton-row" style={{ width: '38%' }} />
              <div className="sex-skeleton-row" style={{ width: '92%' }} />
              <div className="sex-skeleton-row" style={{ width: '74%' }} />
              <div className="sex-skeleton-row" style={{ width: '86%' }} />
              <div className="sex-skeleton-row" style={{ width: '55%' }} />
            </div>
          )}
          {turns.status === 'error' && <div className="sex-error">{turns.error}</div>}
          {turns.status === 'ready' && turns.data?.turns.map(message => {
            const isExpanded = expandedSeq === message.seq
            return (
            <div key={message.seq} data-mtime={String(message.time)} className="sex-message-summary">
              <button type="button" className="sex-message-summary-toggle" aria-expanded={isExpanded} onClick={() => setExpandedSeq(isExpanded ? null : message.seq)}><span className="sex-kind-dot" style={{ background: KIND_COLORS[message.kind] }} /><span className="sex-kind-text" style={{ color: KIND_COLORS[message.kind] }}>{kindLabel(message.kind, t)}</span><span className="sex-message-summary-time">{formatTime(message.time)}</span><span>#{message.seq}</span><span className="sex-message-summary-text">{message.text || t('timelineNoSummary')}</span><span aria-hidden="true" className={'sex-message-summary-arrow' + (isExpanded ? ' sex-message-summary-arrow-open' : '')}>▸</span></button>
              <div className={'sex-message-expanded-wrap' + (isExpanded ? ' sex-message-expanded-open' : '')}>
                <div className="sex-message-expanded">{message.text || t('timelineNoSummary')}</div>
              </div>
            </div>
            )
          })}
          {turns.status === 'ready' && turns.data?.turns.length === 0 && <div className="sex-empty">{t('timelineNoTurns')}</div>}
        </div>
      </aside>}
    </div>
  </div>
}

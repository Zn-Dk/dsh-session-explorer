/**
 * Timeline overview: searchable session grid + in-place message summary detail.
 * This intentionally does not jump to the original conversation: the host has
 * no stable anchor API yet, so the plugin must remain useful on its own.
 */
import { useMemo, useState, useCallback } from 'react'
import type { MessageKind, TimelineNode, TimelineTurnsResponse, TimelineNodeKind } from '../../protocol.js'
import { useI18n, type LocaleServiceLike } from '../i18n.js'

export interface TimelineViewProps {
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

export function TimelineView({ nodes, selectedSessionId, turns, onSelectSession, onDrillTurn, onPreview, locale }: TimelineViewProps) {
  const { t } = useI18n(locale)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<TimelineNodeKind | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('updated')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [wsOpen, setWsOpen] = useState(false)
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null)

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

  // 过滤/排序/搜索全部客户端完成（nodes 已含全量摘要数据），不触发服务器
  // round-trip——之前 onFilter 每个按键都让 App 把整个视图切换成 loading 占位，表现为"整页刷新"。
  const applyQuery = useCallback((value: string) => { setQuery(value) }, [])
  const applyKind = useCallback((value: TimelineNodeKind | 'all') => { setKind(value) }, [])
  const applySortKey = useCallback((value: SortKey) => { setSortKey(value) }, [])
  const applySortDir = useCallback(() => { setSortDir(d => d === 'asc' ? 'desc' : 'asc') }, [])
  const toggleWorkspace = useCallback((cwd: string) => {
    setWorkspaces(list => list.includes(cwd) ? list.filter(x => x !== cwd) : [...list, cwd])
  }, [])

  if (nodes.length === 0) return <div className="sex-empty">{t('timelineEmpty')}</div>
  return <div className="sex-timeline-overview">
    <div className="sex-timeline-toolbar">
      <input className="sex-input sex-timeline-search" value={query} placeholder={t('timelineSearchPlaceholder')} onChange={e => applyQuery(e.target.value)} />
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
        {visible.map(node => <button key={node.sessionId} type="button" className={'sex-session-card sex-session-card-' + node.kind + (selected !== null && selectedSessionId === node.sessionId ? ' sex-session-card-selected' : '')} onClick={() => { onSelectSession(selectedSessionId === node.sessionId ? '' : node.sessionId) }}>
          <div className="sex-session-card-head"><strong>{node.title ?? node.sessionId.slice(0, 12)}</strong><span className={'sex-kind-badge sex-kind-badge-' + node.kind}>{t(node.kind === 'child' ? 'timelineChild' : 'timelineMain')}</span></div>
          <div className="sex-session-card-meta">{shortCwd(node.cwd) || t('timelineUnknownDir')} · {formatTime(node.updatedAt)}</div>
          <div className="sex-session-card-stats">{t('timelineMessages', { n: String(node.messageCount) })} · {t('timelineTools', { n: String(node.toolCount) })}</div>
          <div className="sex-session-card-summary">{node.latestMessage?.text || node.firstMessage?.text || t('timelineNoSummary')}</div>
        </button>)}
      </div>
      {selected && <aside className="sex-session-detail">
        <div className="sex-session-detail-head"><div><h3>{selected.title ?? selected.sessionId}</h3><div className="sex-session-detail-meta">{shortCwd(selected.cwd) || t('timelineUnknownDir')} · {formatTime(selected.createdAt)} → {formatTime(selected.updatedAt)}</div></div><span className={'sex-kind-badge sex-kind-badge-' + selected.kind}>{t(selected.kind === 'child' ? 'timelineChild' : 'timelineMain')}</span></div>
        <div className="sex-session-detail-lineage">{t('timelineLineage')}: {selected.parentSessionId ? selected.parentSessionId.slice(0, 12) : t('timelineRootSession')}</div>
        <div className="sex-message-summary-list">
          {turns.status === 'loading' && <div className="sex-empty">{t('previewLoading')}</div>}
          {turns.status === 'error' && <div className="sex-error">{turns.error}</div>}
          {turns.status === 'ready' && turns.data?.turns.map(message => <div key={message.seq} className="sex-message-summary">
            <button type="button" className="sex-message-summary-toggle" onClick={() => setExpandedSeq(expandedSeq === message.seq ? null : message.seq)}><span className="sex-kind-dot" style={{ background: KIND_COLORS[message.kind] }} /><span className="sex-kind-text" style={{ color: KIND_COLORS[message.kind] }}>{kindLabel(message.kind, t)}</span><span className="sex-message-summary-time">{formatTime(message.time)}</span><span>#{message.seq}</span><span className="sex-message-summary-text">{message.text || t('timelineNoSummary')}</span></button>
            {expandedSeq === message.seq && <div className="sex-message-expanded">{message.text || t('timelineNoSummary')}</div>}
          </div>)}
          {turns.status === 'ready' && turns.data?.turns.length === 0 && <div className="sex-empty">{t('timelineNoTurns')}</div>}
        </div>
      </aside>}
    </div>
  </div>
}

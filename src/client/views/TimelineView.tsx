/**
 * Timeline overview: searchable session grid + in-place message summary detail.
 * This intentionally does not jump to the original conversation: the host has
 * no stable anchor API yet, so the plugin must remain useful on its own.
 */
import { useMemo, useState, useCallback, useEffect } from 'react'
import type { TimelineNode, TimelineTurnsResponse, TimelineNodeKind } from '../../protocol.js'
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

const formatTime = (value: number): string => new Date(value).toLocaleString()
const kindLabel = (kind: string, t: (key: any, vars?: Record<string, string>) => string): string => kind === 'user' ? t('kindUser' as never) : kind === 'assistant' ? t('kindAssistant' as never) : kind === 'steering' ? t('kindSteering' as never) : t('kindTool' as never)
const shortCwd = (value: string | null): string => value ? (value.split(/[\/]/).filter(Boolean).pop() ?? value) : ''

export function TimelineView({ nodes, selectedSessionId, turns, onSelectSession, onDrillTurn, onPreview, locale }: TimelineViewProps) {
  const { t } = useI18n(locale)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<TimelineNodeKind | 'all'>('all')
  const [sort, setSort] = useState<'updated' | 'created' | 'messages'>('updated')
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null)

  const selected = selectedSessionId === null || selectedSessionId === '' ? null : nodes.find(n => n.sessionId === selectedSessionId) ?? null
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return nodes.filter(n => {
      if (kind !== 'all' && n.kind !== kind) return false
      if (!q) return true
      const hay = [n.title, n.cwd, n.sessionId, n.firstMessage?.text, n.latestMessage?.text].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    }).sort((a,b) => sort === 'created' ? b.createdAt-a.createdAt : sort === 'messages' ? b.messageCount-a.messageCount : b.updatedAt-a.updatedAt)
  }, [nodes, query, kind, sort])

  // 过滤/排序/搜索全部客户端完成（nodes 已含全量摘要数据），不触发服务器
  // round-trip——之前 onFilter 每个按键都让 App 把整个视图切换成 loading 占位，表现为"整页刷新"。
  const applyQuery = useCallback((value: string) => { setQuery(value) }, [])
  const applyKind = useCallback((value: TimelineNodeKind | 'all') => { setKind(value) }, [])
  const applySort = useCallback((value: 'updated' | 'created' | 'messages') => { setSort(value) }, [])

  if (nodes.length === 0) return <div className="sex-empty">{t('timelineEmpty')}</div>
  return <div className="sex-timeline-overview">
    <div className="sex-timeline-toolbar">
      <input className="sex-input sex-timeline-search" value={query} placeholder={t('timelineSearchPlaceholder')} onChange={e => applyQuery(e.target.value)} />
      <div className="sex-timeline-filters">
        {KIND_OPTIONS.map(option => <button key={option.value} type="button" className={'sex-filter-chip' + (kind === option.value ? ' sex-filter-chip-on' : '')} onClick={() => applyKind(option.value)}>{t(option.key)}</button>)}
      </div>
      <select className="sex-timeline-sort" value={sort} aria-label={t('timelineSort')} onChange={e => applySort(e.target.value as typeof sort)}>
        <option value="updated">{t('timelineSortUpdated')}</option><option value="created">{t('timelineSortCreated')}</option><option value="messages">{t('timelineSortMessages')}</option>
      </select>
      <span className="sex-timeline-count">{t('timelineVisibleCount', { n: String(visible.length) })}</span>
    </div>
    <div className={'sex-timeline-main' + (selected ? ' sex-timeline-main-split' : '')}>
      <div className="sex-session-grid">
        {visible.map(node => <button key={node.sessionId} type="button" className={'sex-session-card sex-session-card-' + node.kind + (selected !== null && selectedSessionId === node.sessionId ? ' sex-session-card-selected' : '')} onClick={() => { onSelectSession(selectedSessionId === node.sessionId ? '' : node.sessionId) }}>
          <div className="sex-session-card-head"><strong>{node.title ?? node.sessionId.slice(0, 12)}</strong><span className="sex-kind-badge">{t(node.kind === 'child' ? 'timelineChild' : 'timelineMain')}</span></div>
          <div className="sex-session-card-meta">{shortCwd(node.cwd) || t('timelineUnknownDir')} · {formatTime(node.updatedAt)}</div>
          <div className="sex-session-card-stats">{t('timelineMessages', { n: String(node.messageCount) })} · {t('timelineTools', { n: String(node.toolCount) })}</div>
          <div className="sex-session-card-summary">{node.latestMessage?.text || node.firstMessage?.text || t('timelineNoSummary')}</div>
        </button>)}
      </div>
      {selected && <aside className="sex-session-detail">
        <div className="sex-session-detail-head"><div><h3>{selected.title ?? selected.sessionId}</h3><div className="sex-session-detail-meta">{shortCwd(selected.cwd) || t('timelineUnknownDir')} · {formatTime(selected.createdAt)} → {formatTime(selected.updatedAt)}</div></div><span className="sex-kind-badge">{t(selected.kind === 'child' ? 'timelineChild' : 'timelineMain')}</span></div>
        <div className="sex-session-detail-lineage">{t('timelineLineage')}: {selected.parentSessionId ? selected.parentSessionId.slice(0, 12) : t('timelineRootSession')}</div>
        <div className="sex-message-summary-list">
          {turns.status === 'loading' && <div className="sex-empty">{t('previewLoading')}</div>}
          {turns.status === 'error' && <div className="sex-error">{turns.error}</div>}
          {turns.status === 'ready' && turns.data?.turns.map(message => <div key={message.seq} className={'sex-message-summary sex-message-summary-' + message.kind}>
            <button type="button" className="sex-message-summary-toggle" onClick={() => setExpandedSeq(expandedSeq === message.seq ? null : message.seq)}><span className="sex-kind-badge">{kindLabel(message.kind, t)}</span><span>{formatTime(message.time)}</span><span>#{message.seq}</span><span className="sex-message-summary-text">{message.text || t('timelineNoSummary')}</span></button>
            {expandedSeq === message.seq && <div className="sex-message-expanded">{message.text || t('timelineNoSummary')}<div className="sex-message-expanded-note">{t('timelineNoAnchor')}</div></div>}
          </div>)}
          {turns.status === 'ready' && turns.data?.turns.length === 0 && <div className="sex-empty">{t('timelineNoTurns')}</div>}
        </div>
      </aside>}
    </div>
  </div>
}

/**
 * client/App.tsx —— 主面板：搜索 / 时间线 / 预览 三视图切换 + 索引状态。
 */

import { useState, useEffect, useCallback } from 'react'
import type { ExplorerClient, PanelStore } from './store.js'
import { usePanelStore } from './store.js'
import { SearchView } from './views/SearchView.js'
import { TimelineView } from './views/TimelineView.js'
import { PreviewView } from './views/PreviewView.js'
import type { IndexStatus, MessageHit, TimelineNode } from '../protocol.js'

export interface AppProps {
  client: ExplorerClient
  store: PanelStore
  /** 打开真实会话（由 bundle-entry 注入）。 */
  onOpenSession: (sessionId: string) => void
  onClose: () => void
}

type View =
  | { name: 'search' }
  | { name: 'timeline' }
  | { name: 'preview'; sessionId: string; seq: number }

export function App({ client, store, onOpenSession, onClose }: AppProps) {
  const panel = usePanelStore(store)
  const [view, setView] = useState<View>({ name: 'search' })
  const [timeline, setTimeline] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; nodes: TimelineNode[]; error: string | null }>({ status: 'idle', nodes: [], error: null })
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildResult, setRebuildResult] = useState<string | null>(null)

  const loadTimeline = useCallback(async () => {
    setTimeline({ status: 'loading', nodes: [], error: null })
    try {
      const res = await client.timeline(500)
      if (!res.ok) {
        setTimeline({ status: 'error', nodes: [], error: res.message ?? 'timeline failed' })
        return
      }
      setTimeline({ status: 'ready', nodes: res.value ?? [], error: null })
    } catch (error) {
      setTimeline({ status: 'error', nodes: [], error: String(error) })
    }
  }, [client])

  const loadIndexStatus = useCallback(async () => {
    try {
      const res = await client.indexStatus()
      if (res.ok && res.value) setIndexStatus(res.value)
    } catch { /* 非关键 */ }
  }, [client])

  useEffect(() => {
    if (!panel.open) return
    void loadIndexStatus()
  }, [panel.open, loadIndexStatus])

  const doRebuild = useCallback(async () => {
    setRebuilding(true)
    setRebuildResult(null)
    try {
      const res = await client.rebuild()
      setRebuildResult(res.ok
        ? '重建完成：成功 ' + (res.value?.succeeded ?? 0) + '，失败 ' + (res.value?.failed ?? 0)
        : '重建失败：' + (res.message ?? 'unknown'))
      await loadTimeline()
      await loadIndexStatus()
    } catch (error) {
      setRebuildResult('重建失败：' + String(error))
    } finally {
      setRebuilding(false)
    }
  }, [client, loadTimeline, loadIndexStatus])

  const openTimeline = useCallback(() => {
    setView({ name: 'timeline' })
    void loadTimeline()
  }, [loadTimeline])

  const openPreview = useCallback((sessionId: string, seq: number | null) => {
    // 时间线节点点击没有 seq → 用 0 占位不生效？时间线预览改为会话级概览：
    // 这里统一把无 seq 视为 preview(null)，由 App 处理。
    if (seq === null) {
      // 无 seq：直接跳真实会话更符合预期
      onOpenSession(sessionId)
      return
    }
    setView({ name: 'preview', sessionId, seq })
  }, [onOpenSession])

  const openPreviewFromHit = useCallback((hit: MessageHit) => {
    setView({ name: 'preview', sessionId: hit.sessionId, seq: hit.seq })
  }, [])

  if (!panel.open) return null

  return (
    <div className="sex-app">
      <div className="sex-header">
        <div className="sex-tabs">
          <button
            type="button"
            className={'sex-tab' + (view.name === 'search' ? ' sex-tab-on' : '')}
            onClick={() => { setView({ name: 'search' }) }}
          >
            消息检索
          </button>
          <button
            type="button"
            className={'sex-tab' + (view.name === 'timeline' ? ' sex-tab-on' : '')}
            onClick={openTimeline}
          >
            时间线
          </button>
        </div>
        <div className="sex-header-right">
          {indexStatus && (
            <span className="sex-status">
              已索引 {indexStatus.indexedSessions}/{indexStatus.totalSessions} 会话
              {indexStatus.staleSessions > 0 ? ' · ' + indexStatus.staleSessions + ' 待同步' : ''}
            </span>
          )}
          <button type="button" className="sex-mini-btn" disabled={rebuilding} onClick={() => { void doRebuild() }}>
            {rebuilding ? '重建中…' : '重建索引'}
          </button>
          <button type="button" className="sex-close" aria-label="关闭" onClick={onClose}>×</button>
        </div>
      </div>
      {rebuildResult && <div className="sex-notice">{rebuildResult}</div>}
      <div className="sex-body">
        {view.name === 'search' && <SearchView client={client} onPreview={openPreviewFromHit} onOpenSession={onOpenSession} />}
        {view.name === 'timeline' && (timeline.status === 'loading'
          ? <div className="sex-empty">加载时间线…</div>
          : timeline.status === 'error'
            ? <div className="sex-error">{timeline.error}</div>
            : <TimelineView client={client} nodes={timeline.nodes} onPreview={openPreview} />)}
        {view.name === 'preview' && (
          <PreviewView
            client={client}
            sessionId={view.sessionId}
            seq={view.seq}
            onBack={() => { setView({ name: 'search' }) }}
            onOpenSession={onOpenSession}
          />
        )}
      </div>
    </div>
  )
}

/**
 * client/App.tsx —— 主面板：搜索 / 时间线 / 预览 三视图切换 + 索引状态。
 */

import { useState, useEffect, useCallback, createElement } from 'react'
import type { ExplorerClient, PanelStore } from './store.js'
import { envelopeError, usePanelStore } from './store.js'
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
  /** DSH 平台 Tooltip 组件（由 bundle-entry 从 primitives seed 注入）。 */
  Tooltip?: unknown
}

type View =
  | { name: 'search' }
  | { name: 'timeline' }
  | { name: 'preview'; sessionId: string; seq: number }

export function App({ client, store, onOpenSession, onClose, Tooltip }: AppProps) {
  const panel = usePanelStore(store)
  const [view, setView] = useState<View>({ name: 'search' })
  const [timeline, setTimeline] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; nodes: TimelineNode[]; error: string | null }>({ status: 'idle', nodes: [], error: null })
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildResult, setRebuildResult] = useState<string | null>(null)
  const [rebuildDialog, setRebuildDialog] = useState<{ open: boolean; health: { healthy: boolean; problems: string[] } | null; checking: boolean; mode: 'incremental' | 'full' }>({ open: false, health: null, checking: false, mode: 'incremental' })

  const loadTimeline = useCallback(async () => {
    setTimeline({ status: 'loading', nodes: [], error: null })
    try {
      const res = await client.timeline(500)
      if (!res.ok) {
        setTimeline({ status: 'error', nodes: [], error: envelopeError(res) || 'timeline failed' })
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
    void (async () => {
      // 面板打开时同步一次（live 会话最新消息 + 未索引新会话），再刷新状态
      try { await client.sync() } catch { /* 非关键 */ }
      await loadIndexStatus()
    })()
  }, [panel.open, loadIndexStatus, client])

  const doRebuild = useCallback(async (mode: 'incremental' | 'full') => {
    setRebuildDialog((d) => ({ ...d, open: false }))
    setRebuilding(true)
    setRebuildResult(null)
    try {
      const res = await client.rebuild(mode)
      if (res.ok) {
        const r = res.value
        const parts: string[] = []
        if (r) {
          if (mode === 'incremental') {
            parts.push('新增 ' + (r.added ?? 0), '删除 ' + (r.removed ?? 0), '重刷 ' + (r.refreshed ?? 0), '跳过 ' + (r.skipped ?? 0))
          }
          parts.push('成功 ' + (r.succeeded ?? 0), '失败 ' + (r.failed ?? 0))
          const firstFailure = r.failures?.[0]?.error
          if (r.failed > 0) parts.push('首个失败：' + (firstFailure ?? '未知'))
        }
        setRebuildResult((mode === 'incremental' ? '增量重建完成：' : '全量重建完成：') + parts.join('，'))
      } else {
        setRebuildResult('重建失败：' + (envelopeError(res) || '未知错误'))
      }
      await loadTimeline()
      await loadIndexStatus()
    } catch (error) {
      setRebuildResult('重建失败：' + String(error))
    } finally {
      setRebuilding(false)
    }
  }, [client, loadTimeline, loadIndexStatus])

  // 打开重建 dialog：先做健康检查
  const openRebuildDialog = useCallback(() => {
    setRebuildDialog({ open: true, health: null, checking: true, mode: 'incremental' })
    void (async () => {
      try {
        const res = await client.healthCheck()
        if (res.ok && res.value) {
          const health = res.value
          setRebuildDialog((d) => ({ ...d, checking: false, health, mode: health.healthy ? 'incremental' : 'full' }))
        } else {
          setRebuildDialog((d) => ({ ...d, checking: false, health: { healthy: false, problems: [envelopeError(res) || '健康检查失败'] }, mode: 'full' }))
        }
      } catch (error) {
        setRebuildDialog((d) => ({ ...d, checking: false, health: { healthy: false, problems: [String(error)] }, mode: 'full' }))
      }
    })()
  }, [client])

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
            <span className={'sex-status' + (indexStatus.staleSessions > 0 ? ' sex-status-stale' : '')}>
              已索引 {indexStatus.indexedSessions}/{indexStatus.totalSessions} 会话
              {indexStatus.staleSessions > 0 ? ' · ' + indexStatus.staleSessions + ' 个待同步，点击重建索引' : ''}
              {indexStatus.failedSessions > 0 ? ' · ' + indexStatus.failedSessions + ' 个源日志损坏（无法索引）' : ''}
            </span>
          )}
          {Tooltip
            ? createElement(Tooltip as never, {
                label: '重建索引：扫描全部历史会话并重建搜索索引。\n• 首次安装插件后自动触发，无需手动操作\n• 仅在索引库损坏、大批量新会话或怀疑索引不一致时使用\n• 日常搜索靠会话切换时的自动同步维护',
                side: 'bottom',
                delayMs: 300,
                maxWidth: 320,
                children: createElement('span', { className: 'sex-help-icon', 'aria-label': '重建索引说明' }, '?'),
              })
            : createElement('span', {
                className: 'sex-help-icon',
                title: '重建索引说明',
                'aria-label': '重建索引说明',
              }, '?')}
          <button type="button" className="sex-mini-btn" disabled={rebuilding} onClick={openRebuildDialog}>
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
      {rebuildDialog.open && (
        <div className="sex-modal-backdrop" onClick={() => { if (!rebuilding) setRebuildDialog((d) => ({ ...d, open: false })) }}>
          <div className="sex-modal" onClick={(event) => { event.stopPropagation() }}>
            <div className="sex-modal-title">重建搜索索引</div>
            {rebuildDialog.checking ? (
              <div className="sex-modal-hint">正在检查索引库健康状态…</div>
            ) : (
              <>
                {rebuildDialog.health && !rebuildDialog.health.healthy && (
                  <div className="sex-modal-warn">
                    索引库健康检查未通过：
                    {rebuildDialog.health.problems.map((p) => <div key={p}>• {p}</div>)}
                    <div>建议选择「全量重建」以修复。</div>
                  </div>
                )}
                {rebuildDialog.health?.healthy && (
                  <div className="sex-modal-hint">索引库健康检查通过。</div>
                )}
                <label className="sex-radio-row">
                  <input
                    type="radio"
                    name="rebuild-mode"
                    checked={rebuildDialog.mode === 'incremental'}
                    onChange={() => { setRebuildDialog((d) => ({ ...d, mode: 'incremental' })) }}
                    disabled={rebuilding}
                  />
                  <span>
                    <strong>增量重建</strong>（推荐，较快）
                    <span className="sex-modal-sub">仅新增未索引会话、清理已删除会话、重刷内容变化的会话；已索引且未变化的会话跳过。</span>
                  </span>
                </label>
                <label className="sex-radio-row">
                  <input
                    type="radio"
                    name="rebuild-mode"
                    checked={rebuildDialog.mode === 'full'}
                    onChange={() => { setRebuildDialog((d) => ({ ...d, mode: 'full' })) }}
                    disabled={rebuilding}
                  />
                  <span>
                    <strong>全量重建</strong>（较慢）
                    <span className="sex-modal-sub">清空索引库并逐会话重建，可修复索引库损坏；历史会话多时可能需要较长时间。</span>
                  </span>
                </label>
              </>
            )}
            <div className="sex-modal-footer">
              <button type="button" className="sex-mini-btn" onClick={() => { setRebuildDialog((d) => ({ ...d, open: false })) }} disabled={rebuilding}>取消</button>
              <button type="button" className="sex-mini-btn sex-primary-btn" disabled={rebuilding || rebuildDialog.checking} onClick={() => { void doRebuild(rebuildDialog.mode) }}>
                {rebuilding ? '重建中…' : '开始重建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

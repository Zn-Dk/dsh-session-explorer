/**
 * client/views/TimelineView.tsx —— 两级时间线画布视图（@xyflow/react）。
 *
 * 上层：会话 → 分组卡片（按 cwd 分组，主代理/子代理两种配色）。
 * 下层：选中卡片后原位展开该会话的二级时间条（按消息时间升序，turn 刻度），
 *       点击时间条跳转真实会话；再次点击卡片折叠。
 *
 * 修复史：0.2.0 因缺 @xyflow/react 官方基础 CSS 崩坏而隐藏入口（bundle-entry
 * 统一注入，build-client.mjs 有产物断言防回归）；0.4.0 两级下钻 + 主/子代理配色。
 */

import { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from '@xyflow/react'
import type { TimelineNode, TimelineTurnsResponse } from '../../protocol.js'
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

const COLOR_MAIN = '#3b82f6'
const COLOR_CHILD = '#8b5cf6'
const GROUP_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']

export function TimelineView({ nodes, selectedSessionId, turns, onSelectSession, onDrillTurn, onPreview, locale }: TimelineViewProps) {
  const { t } = useI18n(locale)

  // 按 cwd 分组；无 cwd 归入「未知目录」文案键。
  const groups = useMemo(() => {
    const map = new Map<string, TimelineNode[]>()
    for (const node of nodes) {
      const key = node.cwd ?? ''
      const list = map.get(key) ?? []
      list.push(node)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].map((n) => n.updatedAt))
      const bMax = Math.max(...b[1].map((n) => n.updatedAt))
      return bMax - aMax
    })
  }, [nodes])

  const { flowNodes, flowEdges } = useMemo(() => {
    const flowNodes: Node[] = []
    const flowEdges: Edge[] = []
    let groupIndex = 0
    let y = 26
    for (const [cwdKey, group] of groups) {
      const groupColor = GROUP_COLORS[groupIndex % GROUP_COLORS.length]
      groupIndex++
      const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt)
      const groupLabel = cwdKey === '' ? t('timelineUnknownDir') : (cwdKey.split('/').pop() || cwdKey)
      const countLabel = t('timelineSessionCount', { n: String(sorted.length) })
      const groupWidth = Math.max(240, sorted.length * 190 + (sorted.length - 1) * 24)

      flowNodes.push({
        id: 'glabel-' + cwdKey,
        position: { x: 2, y: y - 22 },
        draggable: false,
        selectable: false,
        data: { label: groupLabel + ' · ' + countLabel },
        style: { background: 'transparent', border: 'none', boxShadow: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: groupColor, width: groupWidth },
      })
      flowNodes.push({
        id: 'group-' + cwdKey,
        position: { x: 0, y },
        type: 'group' as never,
        data: { label: '' },
        style: { width: groupWidth, minHeight: 120, borderColor: groupColor, background: 'transparent' },
      })

      let x = 16
      for (const session of sorted) {
        const isChild = session.kind === 'child'
        const color = isChild ? COLOR_CHILD : COLOR_MAIN
        const selected = session.sessionId === selectedSessionId
        flowNodes.push({
          id: session.sessionId,
          parentId: 'group-' + cwdKey,
          extent: 'parent' as never,
          position: { x, y: 24 },
          data: {
            label: session.title ?? session.sessionId,
            kind: session.kind,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messageCount,
            toolCount: session.toolCount,
            color,
          },
          style: {
            width: 180,
            borderColor: color,
            borderRadius: 10,
            fontSize: 12,
            background: selected ? 'color-mix(in srgb, ' + color + ' 22%, transparent)' : 'var(--dsw-alias-bg-elevated, #fff)',
            boxShadow: selected ? '0 0 0 2px ' + color : undefined,
          },
        })
        x += 190 + 24
      }
      y += 150
    }
    return { flowNodes, flowEdges }
  }, [groups, selectedSessionId, t])

  const onNodeClick = useCallback((_event: unknown, node: Node) => {
    if (node.id.startsWith('group-') || node.id.startsWith('glabel-')) return
    onSelectSession(node.id)
  }, [onSelectSession])

  const selected = selectedSessionId === null ? null : nodes.find((n) => n.sessionId === selectedSessionId) ?? null

  if (nodes.length === 0) {
    return <div className="sex-empty">{t('timelineEmpty')}</div>
  }

  return (
    <div className="sex-timeline">
      <div className="sex-flow">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          onNodeClick={onNodeClick as never}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      {selected !== null && (
        <div className="sex-drill">
          <div className="sex-drill-head">
            <span className="sex-drill-title">{selected.title ?? selected.sessionId}</span>
            <span className="sex-drill-meta">{t('timelineTurnCount', { n: String(selected.messageCount) })}</span>
            <button type="button" className="sex-mini-btn" onClick={() => { onDrillTurn(selected.sessionId) }}>{t('timelineOpenSession')}</button>
          </div>
          <div className="sex-drill-body">
            {turns.status === 'loading' && <div className="sex-empty">{t('previewLoading')}</div>}
            {turns.status === 'error' && <div className="sex-error">{turns.error}</div>}
            {turns.status === 'ready' && turns.data && (
              turns.data.turns.length === 0
                ? <div className="sex-empty">{t('timelineNoTurns')}</div>
                : (
                  <div className="sex-drill-track">
                    {turns.data.turns.map((turn) => (
                      <button
                        key={turn.seq}
                        type="button"
                        className={'sex-drill-dot' + (turn.kind === 'user' ? ' sex-drill-dot-user' : '')}
                        title={turn.text || ('#' + turn.seq)}
                        onClick={() => { onDrillTurn(selected.sessionId) }}
                      />
                    ))}
                  </div>
                )
            )}
          </div>
        </div>
      )}
    </div>
  )
}

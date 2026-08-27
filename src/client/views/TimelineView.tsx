/**
 * client/views/TimelineView.tsx —— 时间线画布视图（@xyflow/react）。
 * 会话 → 节点；同一 cwd 的会话横向分组，按时间排序；点击节点预览。
 *
 * 修复史：0.2.0 曾因缺 @xyflow/react 官方基础 CSS（viewport/edge/minimap 全套
 * 定位与变换样式）导致画布整体崩坏而隐藏入口。CSS 现由 bundle-entry 统一注入，
 * build-client.mjs 有产物内联断言防回归。
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
import type { ExplorerClient } from '../store.js'
import type { TimelineNode } from '../../protocol.js'
import { useI18n, type LocaleServiceLike } from '../i18n.js'

export interface TimelineViewProps {
  nodes: TimelineNode[]
  onPreview: (sessionId: string, seq: number | null) => void
  /** Host locale 服务（App 注入；缺省回退 navigator.language）。 */
  locale?: LocaleServiceLike
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']

export function TimelineView({ nodes, onPreview, locale }: TimelineViewProps) {
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
    const entries = [...map.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].map((n) => n.updatedAt))
      const bMax = Math.max(...b[1].map((n) => n.updatedAt))
      return bMax - aMax
    })
    return entries
  }, [nodes])

  // xyflow v12 的 group 类型节点不渲染 data.label，组头用独立 label 节点放在组框上方。
  const { flowNodes, flowEdges } = useMemo(() => {
    const flowNodes: Node[] = []
    const flowEdges: Edge[] = []
    let groupIndex = 0
    let y = 26 // 顶部留一行 label 高度
    for (const [cwdKey, group] of groups) {
      const color = COLORS[groupIndex % COLORS.length]
      groupIndex++
      const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt)
      const groupLabel = cwdKey === '' ? t('timelineUnknownDir') : (cwdKey.split('/').pop() || cwdKey)
      const countLabel = t('timelineSessionCount', { n: String(sorted.length) })
      const groupWidth = Math.max(240, sorted.length * 190 + (sorted.length - 1) * 24)

      // 组头（独立节点，不参与父子布局）
      flowNodes.push({
        id: 'glabel-' + cwdKey,
        position: { x: 2, y: y - 22 },
        draggable: false,
        selectable: false,
        data: { label: groupLabel + ' · ' + countLabel },
        style: {
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
          padding: 0,
          fontSize: 12,
          fontWeight: 600,
          color,
          width: groupWidth,
        },
      })

      // 组框
      flowNodes.push({
        id: 'group-' + cwdKey,
        position: { x: 0, y },
        type: 'group' as never,
        data: { label: '' },
        style: { width: groupWidth, minHeight: 120, borderColor: color, background: 'transparent' },
      })

      let x = 16
      for (const session of sorted) {
        flowNodes.push({
          id: session.sessionId,
          parentId: 'group-' + cwdKey,
          extent: 'parent' as never,
          position: { x, y: 24 },
          data: {
            label: session.title ?? session.sessionId,
            cwd: session.cwd,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messageCount,
            toolCount: session.toolCount,
            color,
          },
          style: { width: 180, borderColor: color, borderRadius: 10, fontSize: 12 },
        })
        x += 190 + 24
      }
      y += 150
    }
    return { flowNodes, flowEdges }
  }, [groups, t])

  const onNodeClick = useCallback((_event: unknown, node: Node) => {
    if (node.id.startsWith('group-') || node.id.startsWith('glabel-')) return
    onPreview(node.id, null)
  }, [onPreview])

  if (nodes.length === 0) {
    return <div className="sex-empty">{t('timelineEmpty')}</div>
  }

  return (
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
  )
}

/**
 * client/views/TimelineView.tsx —— 时间线画布视图（@xyflow/react）。
 * 会话 → 节点；同一 cwd 的会话横向排列，按时间排序；点击节点预览。
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

export interface TimelineViewProps {
  client: ExplorerClient
  nodes: TimelineNode[]
  onPreview: (sessionId: string, seq: number | null) => void
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']

export function TimelineView({ client, nodes, onPreview }: TimelineViewProps) {
  // 按 cwd 分组；无 cwd 归入 '未知目录'。
  const groups = useMemo(() => {
    const map = new Map<string, TimelineNode[]>()
    for (const node of nodes) {
      const key = node.cwd ?? '(未知目录)'
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

  const { flowNodes, flowEdges } = useMemo(() => {
    const flowNodes: Node[] = []
    const flowEdges: Edge[] = []
    let groupIndex = 0
    let y = 0
    for (const [cwd, group] of groups) {
      const color = COLORS[groupIndex % COLORS.length]
      groupIndex++
      // 组内按时间排序
      const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt)
      const groupLabel = cwd.split('/').pop() || cwd
      const groupWidth = Math.max(240, sorted.length * 190 + (sorted.length - 1) * 24)
      // 组头
      flowNodes.push({
        id: 'group-' + cwd,
        position: { x: 0, y },
        type: 'group' as never,
        data: { label: groupLabel + ' (' + sorted.length + ' 个会话)' },
        style: { width: groupWidth, minHeight: 120, borderColor: color, background: 'transparent' },
      })
      let x = 16
      for (const session of sorted) {
        flowNodes.push({
          id: session.sessionId,
          parentId: 'group-' + cwd,
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
  }, [groups])

  const onNodeClick = useCallback((_event: unknown, node: Node) => {
    if (node.id.startsWith('group-')) return
    onPreview(node.id, null)
  }, [onPreview])

  if (nodes.length === 0) {
    return <div className="sex-empty">还没有已索引的会话。先启动一次同步（搜索页 / 面板重建索引）。</div>
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
        nodeTypes={undefined}
      >
        <Background gap={20} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  )
}

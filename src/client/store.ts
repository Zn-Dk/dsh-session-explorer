/**
 * client/store.ts —— client 侧状态与 RPC 访问。
 * 全部通过 window.__ModuleLoader__ seed 注入的 react 与 connection 使用；
 * 本文件不 import 任何 host 模块（打包时会被 esbuild 处理）。
 */

import { createElement, useState, useEffect, useSyncExternalStore, useCallback } from 'react'
import type {
  ExplorerRpc,
  IndexStatus,
  MessageHit,
  PreviewPage,
  SearchRequest,
  SearchResponse,
  TimelineNode,
  TimelineTurnsResponse,
} from '../protocol.js'

/** 面板开关状态（shared by sidebar entry + overlay panel）。 */
export interface PanelState {
  open: boolean
}

export function createPanelStore() {
  let state: PanelState = { open: false }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): PanelState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: (): void => {
      if (state.open) return
      state = { open: true }
      for (const listener of listeners) listener()
    },
    close: (): void => {
      if (!state.open) return
      state = { open: false }
      for (const listener of listeners) listener()
    },
    toggle: (): void => {
      state = { open: !state.open }
      for (const listener of listeners) listener()
    },
  }
}

export type PanelStore = ReturnType<typeof createPanelStore>

/** RPC 结果包（host dispatch 的返回形状：ok true → value；ok false → error）。 */
export interface RpcEnvelope<T> {
  ok: boolean
  value?: T
  /** 失败时的错误对象（引擎 rpcResultSchema 形状）。 */
  error?: { code: string; message: string; details?: Record<string, unknown> }
  /** 兼容：部分路径直接给 code/message（旧形状）。 */
  code?: string
  message?: string
}

/** 从 envelope 提取可显示的错误文本。 */
export function envelopeError(res: { ok: boolean; error?: { message?: string; code?: string }; code?: string; message?: string }): string {
  if (!res.ok) {
    if (res.error?.message) return res.error.message
    if (res.message) return res.message
    if (res.error?.code) return res.error.code
    if (res.code) return res.code
    return '未知错误'
  }
  return ''
}

/** client 侧 rpc 封装。 */
export interface ExplorerClient {
  search(request: SearchRequest): Promise<RpcEnvelope<SearchResponse>>
  timeline(options?: Record<string, unknown>): Promise<RpcEnvelope<TimelineNode[]>>
  turns(sessionId: string, limit?: number): Promise<RpcEnvelope<TimelineTurnsResponse>>
  preview(sessionId: string, seq: number, before?: number, after?: number): Promise<RpcEnvelope<PreviewPage | null>>
  indexStatus(): Promise<RpcEnvelope<IndexStatus>>
  /** 打开面板时触发一次轻量同步（live 会话 + 未索引新会话）。 */
  sync(): Promise<RpcEnvelope<{ synced: number; failed: number }>>
  /** 索引库健康检查（dialog 展示用）。 */
  healthCheck(): Promise<RpcEnvelope<{ healthy: boolean; problems: string[] }>>
  rebuild(mode: 'incremental' | 'full'): Promise<RpcEnvelope<{
    mode: string
    total: number
    added: number
    removed: number
    refreshed: number
    skipped: number
    succeeded: number
    failed: number
    failures: Array<{ sessionId: string; indexed: boolean; error?: string }>
  }>>
}

/**
 * 从 connection 构造 rpc 客户端。
 * @param connection DSH client connection service（ctx.connection）。
 * @param channel RPC 通道名。
 */
export function createExplorerClient(connection: unknown, channel: string): ExplorerClient {
  const rpc = (connection as { rpc?: { call?: (channel: string, method: string, payload?: unknown) => Promise<unknown> } })?.rpc
  if (!rpc || typeof rpc.call !== 'function') {
    throw new Error('dsh-session-explorer: connection.rpc.call is unavailable')
  }
  // payload 必须始终可 JSON 序列化且非 undefined：引擎 clientRequestSchema 要求
  // payload 字段存在（z.unknown() 非 optional），undefined 会被 JSON.stringify 丢弃 → 请求校验失败。
  const call = (method: string, payload?: unknown): Promise<unknown> => rpc.call!(channel, method, payload === undefined ? {} : payload)
  return {
    search: (request) => call('search', request) as Promise<RpcEnvelope<SearchResponse>>,
    timeline: (options) => call('timeline', options ?? {}) as Promise<RpcEnvelope<TimelineNode[]>>,
    turns: (sessionId, limit) => call('turns', limit ? { sessionId, limit } : { sessionId }) as Promise<RpcEnvelope<TimelineTurnsResponse>>,
    preview: (sessionId, seq, before, after) => call('preview', { sessionId, seq, before, after }) as Promise<RpcEnvelope<PreviewPage | null>>,
    indexStatus: () => call('indexStatus') as Promise<RpcEnvelope<IndexStatus>>,
    sync: () => call('sync') as Promise<RpcEnvelope<{ synced: number; failed: number }>>,
    healthCheck: () => call('healthCheck') as Promise<RpcEnvelope<{ healthy: boolean; problems: string[] }>>,
    rebuild: (mode) => call('rebuild', { mode }) as Promise<RpcEnvelope<{
      mode: string
      total: number
      added: number
      removed: number
      refreshed: number
      skipped: number
      succeeded: number
      failed: number
      failures: Array<{ sessionId: string; indexed: boolean; error?: string }>
    }>>,
  }
}

/** 惰性错误描述。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** usePanelStore hook。 */
export function usePanelStore(store: PanelStore): PanelState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

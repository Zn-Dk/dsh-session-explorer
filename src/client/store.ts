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

/** RPC 结果包（host dispatch 的返回形状）。 */
export interface RpcEnvelope<T> {
  ok: boolean
  value?: T
  code?: string
  message?: string
}

/** client 侧 rpc 封装。 */
export interface ExplorerClient {
  search(request: SearchRequest): Promise<RpcEnvelope<SearchResponse>>
  timeline(limit?: number): Promise<RpcEnvelope<TimelineNode[]>>
  preview(sessionId: string, seq: number, before?: number, after?: number): Promise<RpcEnvelope<PreviewPage | null>>
  indexStatus(): Promise<RpcEnvelope<IndexStatus>>
  rebuild(): Promise<RpcEnvelope<{ total: number; succeeded: number; failed: number }>>
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
  const call = (method: string, payload?: unknown): Promise<unknown> => rpc.call!(channel, method, payload)
  return {
    search: (request) => call('search', request) as Promise<RpcEnvelope<SearchResponse>>,
    timeline: (limit) => call('timeline', limit ? { limit } : {}) as Promise<RpcEnvelope<TimelineNode[]>>,
    preview: (sessionId, seq, before, after) => call('preview', { sessionId, seq, before, after }) as Promise<RpcEnvelope<PreviewPage | null>>,
    indexStatus: () => call('indexStatus') as Promise<RpcEnvelope<IndexStatus>>,
    rebuild: () => call('rebuild') as Promise<RpcEnvelope<{ total: number; succeeded: number; failed: number }>>,
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

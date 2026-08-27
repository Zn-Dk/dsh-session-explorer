/**
 * rpc.ts —— RPC 请求校验与路由分发（纯逻辑层）。
 *
 * 校验用 zod；错误统一为 { ok: false, code, message } 形状，
 * 路由表把 method 名映射到注入的 handler。indexer/transcript 均
 * 零 cordis 依赖，本模块也是——装配在 host/index.ts 完成。
 */

import { z } from 'zod'
import type {
  ExplorerRpc,
  MessageKind,
  PreviewRequest,
  RebuildRequest,
  SearchRequest,
  SearchResponse,
  TimelineRequest,
  TurnsRequest,
} from './protocol.js'

/** 引擎 rpcResultSchema 的错误分支形状（code 必须是 rpcErrorSchema 的合法值）。 */
export interface RpcError {
  code: string
  message: string
  details: Record<string, unknown>
}

/** 单个 RPC 调用的结果包（与引擎 rpcResultSchema 对齐）。 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/** 业务 handler 抛错时把任意错误压成结果包。 */
export async function toResult<T>(run: () => Promise<T> | T): Promise<RpcResult<T>> {
  try {
    const value = await run()
    return { ok: true as const, value }
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

const messageKindSchema = z.enum(['user', 'assistant', 'steering', 'tool'])

export const searchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  kinds: z.array(messageKindSchema).max(4).optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  cwd: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
})

export const turnsRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(500).optional(),
})

export const timelineRequestSchema = z.object({
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
})

export const rebuildRequestSchema = z.object({
  mode: z.enum(['incremental', 'full']),
})

export const previewRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  before: z.number().int().min(0).max(50).optional(),
  after: z.number().int().min(0).max(50).optional(),
})

function fail(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'bad-request', message, details: {} } }
}

function validate<T>(schema: z.ZodType<T>, input: unknown): T | { message: string } {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const first = parsed.error.issues[0]
  return {
    message: first ? (first.path.join('.') || 'request') + ': ' + first.message : 'invalid request',
  }
}

/**
 * 用注入的 handler 实现 dispatch 一个 RPC 请求。
 * @param handlers 各 method 的纯业务实现（异常会转成结果包）。
 * @param method 请求方法名。
 * @param args 请求参数（原样交给 zod 校验）。
 */
export async function dispatch(
  handlers: ExplorerRpc,
  method: string,
  rawArgs: unknown,
): Promise<RpcResult<unknown>> {
  // payload 缺失/undefined 统一归一化为空对象（引擎可能丢字段）
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs
  switch (method) {
    case 'search': {
      const parsed = validate(searchRequestSchema, args)
      if (!('query' in parsed)) return fail(parsed.message)
      return toResult(() => handlers.search(parsed as SearchRequest))
    }
    case 'turns': {
      const parsed = validate(turnsRequestSchema, args ?? {})
      if ('message' in parsed) return fail(parsed.message)
      return toResult(() => handlers.turns(parsed as TurnsRequest))
    }
    case 'timeline': {
      const parsed = validate(timelineRequestSchema, args ?? {})
      if ('message' in parsed) return fail(parsed.message)
      return toResult(() => handlers.timeline(parsed as TimelineRequest | undefined))
    }
    case 'preview': {
      const parsed = validate(previewRequestSchema, args)
      if (!('sessionId' in parsed)) return fail(parsed.message)
      return toResult(() => handlers.preview(parsed as PreviewRequest))
    }
    case 'indexStatus': {
      return toResult(() => handlers.indexStatus())
    }
    case 'sync': {
      return toResult(() => handlers.sync())
    }
    case 'healthCheck': {
      return toResult(() => handlers.healthCheck())
    }
    case 'rebuild': {
      const parsed = validate(rebuildRequestSchema, args ?? {})
      if ('message' in parsed) return fail(parsed.message)
      return toResult(() => handlers.rebuild(parsed as RebuildRequest))
    }
    default:
      return fail('unknown method: ' + method)
  }
}

/** client 侧共用的 message kind 列表。 */
export const MESSAGE_KINDS: MessageKind[] = ['user', 'assistant', 'steering', 'tool']

export type { MessageKind, SearchRequest, SearchResponse, TimelineRequest, PreviewRequest }

/**
 * dsh-session-explorer —— RPC 契约类型（Host/Client 共享的纯类型层）。
 * 只定义数据形状；运行时校验用 zod codec（见 rpc.ts）。
 */

/** 消息条目的角色分类（索引与搜索权重以此为准）。 */
export type MessageKind = 'user' | 'assistant' | 'steering' | 'tool'

/** 一条待索引的消息条目（transcript.ts 的输出、indexer.ts 的输入）。 */
export interface IndexableMessage {
  /** 会话 id。 */
  sessionId: string
  /** 事件 seq（定位锚点；DSH seq 是全局分配器，只作唯一键，勿作连续索引）。 */
  seq: number
  /** 消息种类。 */
  kind: MessageKind
  /** 事件时间（epoch ms）。 */
  time: number
  /** turn 序号（无则为 null）。 */
  turn: number | null
  /** 正文（user/assistant/steering 的纯文本；tool 条目为空串）。 */
  textMain: string
  /** 低权重检索文本：工具名 + 参数 + 错误摘要（普通消息为空串）。 */
  textTool: string
}

/** 一次搜索命中的单条消息（RPC 返回给浏览器）。 */
export interface MessageHit {
  sessionId: string
  seq: number
  kind: MessageKind
  time: number
  turn: number | null
  /** 会话显示标题（无则 null，client 回退 cwd/ID）。 */
  sessionTitle: string | null
  /** 会话工作目录。 */
  cwd: string | null
  /** 命中片段（纯文本，含省略号）。 */
  snippet: string
  /** 命中的列：main 或 tool。 */
  hitField: 'main' | 'tool'
}

/** 时间线节点（会话级摘要，不加载消息正文）。 */
export interface TimelineNode {
  sessionId: string
  title: string | null
  cwd: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  toolCount: number
}

/** 预览页：焦点消息 + 上下文窗口。 */
export interface PreviewPage {
  sessionId: string
  sessionTitle: string | null
  cwd: string | null
  focus: IndexableMessage
  context: IndexableMessage[]
}

/** 索引健康状态。 */
export interface IndexStatus {
  totalSessions: number
  indexedSessions: number
  staleSessions: number
  failedSessions: number
  lastSyncAt: number | null
  /** 索引里有但磁盘已不存在的会话数（应清理）。 */
  ghostSessions: number
}

/** 搜索请求。 */
export interface SearchRequest {
  query: string
  kinds?: MessageKind[]
  from?: number
  to?: number
  cwd?: string
  limit?: number
  offset?: number
}

/** 搜索响应。 */
export interface SearchResponse {
  items: MessageHit[]
  nextOffset?: number | null
}

/** 搜索结果条目（client 视图可直接消费）。 */
export interface SearchResultItem extends MessageHit {}

/** RPC 端点方法表（host 实现，client 消费）。 */
export interface ExplorerRpc {
  search(request: SearchRequest): Promise<SearchResponse>
  timeline(request?: TimelineRequest): Promise<TimelineNode[]>
  preview(request: PreviewRequest): Promise<PreviewPage | null>
  indexStatus(): Promise<IndexStatus>
  rebuild(): Promise<RebuildResponse>
}

/** 时间线请求。 */
export interface TimelineRequest {
  from?: number
  to?: number
  limit?: number
}

/** 预览请求。 */
export interface PreviewRequest {
  sessionId: string
  seq: number
  before?: number
  after?: number
}

/** 单会话索引结果（用于 rebuild 报告）。 */
export interface SessionIndexOutcome {
  sessionId: string
  indexed: boolean
  error?: string
}

/** 重建响应。 */
export interface RebuildResponse {
  total: number
  succeeded: number
  failed: number
  failures: SessionIndexOutcome[]
}

## 提案：为会话历史增加「按 seq 中心寻址」读取与打开锚点（search → jump to message）

> 关联插件：https://github.com/Zn-Dk/dsh-session-explorer （会话消息级全文检索浏览器）
> 可行性研究（含源码引用与数据）：`docs/jump-to-session-feasibility.md`（已 push 到插件仓库）

### 背景

dsh-session-explorer 可以全量检索会话消息（22.9 万条 / 445 会话），但命中后只能**面板内预览**，无法「打开真实会话并滚动定位到该消息」——用户必须手动翻到对应位置，深会话（本机实测单会话最深 4,263 条消息，maxSeq ≈ 775k）基本不可用。

### 根因（源码级）

1. `session.history` 只有 `beforeSeq/maxMessages`（尾部页 + 向前翻页），**没有中心寻址**：
   `packages/host/apiproxy/src/api/sessions.schema.ts`（`sessionHistoryRequestSchema`）与 `api-proxy.ts` 的 `paginate()`。
2. 会话窗口模型：打开拉尾部 50 条（`PAGE_MESSAGES=50`），`loadOlder()` 每次向前 50 条 —— 跳 p95 会话（2,612 条）要 53 次翻页，每次 JSONL 后端都全量解压解码（最深日志 19.9 MB）。
3. `ctx.sessions.open(id)` 只收 sessionId，无锚点参数；`ISession` 无 seek API。
4. UI 侧已有可复用的锚点机制：`ChatView` 的 `ChatScrollPosition {anchorKey, anchorTop, scrollTop}` 会在 `openState==='open'` 首次挂载时恢复（`ChatView.tsx:261-277`）；节点 key = `conversationContextKey(kind,id)`（用户消息 = `13:input-message<messageId>`，assistant = `16:assistant-step<turn:step>`）。

### 建议改动（小、向后兼容）

1. `session.history` 增加可选 `afterSeq`（语义：从该 seq 起向后 `maxMessages` 条；与 `beforeSeq` 互斥，缺省保持现状）：sqlite 后端可走已有 `loadStoredFrom(fromSeq)` seek 原语（`coordinator.ts:176`），JSONL 后端退化为一次全量解码（可接受，单次而非 85 次）。
2. `session.open` / `sessions.open` 增加可选 `anchorSeq`：打开后窗口以锚点为中心（或先 afterSeq 拉到锚点页），并把 `ChatView` 的 `chatScroll` 注入改为允许外部预置（或新增 `open` 参数直达首帧定位）。
3. （可选）把 `session-query.readEvent` 的窗口能力暴露为浏览器 RPC，作为轻量方案。

### 收益

- 搜索/时间线/轨迹类插件都能「一键跳到命中消息」，深会话不再需要 85 次翻页。
- 向后兼容：全部参数可选，缺省行为与现在完全一致。

### 验证方式

- 单元：`paginate()` 增加 afterSeq 分支测试；`ChatView` 增加「打开即跳转锚点」用例（已有 `chat-view.client.spec.tsx` 恢复锚点用例可扩展）。
- 真机：dsh-session-explorer 的「打开会话」从预览改为带锚点跳转，验证深会话定位。

如果团队认可方向，我可以按此实现并提交（或按贵司流程提供补丁）。
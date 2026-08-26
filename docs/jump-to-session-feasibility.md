# 可行性研究：搜索命中 → 跳转真实会话并锚定滚动定位

> 状态：研究完成（2026-08-27）｜结论：**纯插件不可行，需上游 harness 小补丁（Discussion 提案）**
> 上游仓库不接受外部 PR/Issue，贡献通道 = GitHub Discussions（[CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)）。

## 1. 目标

在 dsh-session-explorer 中，用户点开搜索结果命中条目后，能跳转到**真实 UI 会话**并**滚动定位到命中消息**所在位置（而非仅面板内预览、跳转后落在会话底部）。

## 2. 现状（v0.3.0）

- 搜索命中 → 面板内 `PreviewView`（±20 条上下文）→「打开会话」→ `onOpenSession(sessionId)` → 仅 `ctx.sessions.open(id)` 切换会话，**无定位**，落在会话尾部。
- 索引规模（本机 2026-08-27 实测）：445 会话 / 229,425 条消息 / 索引 859 MB；单会话最深 4,263 条消息（maxSeq ≈ 775k）；最大日志 19.9 MB（zstd 压缩）。
- 会话大小分布（真实数据）：p50=143、p75=584、p90=1,729、p95=2,612、p99=3,821、max=4,263 条消息。

## 3. 关键架构事实（harness 源码 primary source）

| 事实 | 位置 |
|---|---|
| 会话滚动容器 = `[data-conversation-scroll]`；chat 流每行挂 `data-chat-anchor-key`（节点稳定 key） | `packages/client/ui-conversation/src/client/chat/ChatView.tsx`、`ChatNodeSeat.tsx:46` |
| `ChatView` 已有语义锚点恢复：`ChatScrollPosition {anchorKey, anchorTop, scrollTop}`，`openState==='open'` 首次挂载时经注入的 `chatScroll.read()` 恢复 | `ChatView.tsx:261-277`；注入实现 `packages/client/ui-conversation/src/client/apply.ts:412-417` |
| `chatScrollPositions` 是 apply 内部 per-session Map，**不导出**，插件无法预写 | `apply.ts:151` |
| 节点 key = `conversationContextKey(kind,id)`：用户/steering = `13:input-message<messageId>`（id 是**全局 MessageId，非 seq**）；assistant = `16:assistant-step<turn:step>` | `packages/client/runtime/src/client/contract/conversation.ts:272`、`conversation-nodes/message.ts` |
| `ctx.sessions.open(id)` 只收 sessionId，**无锚点参数**；`ISession`/SessionFace 无 seek/jump API | `packages/client/runtime/src/client/contract/sessions.ts:26`、`contract/session.ts:30` |
| 会话窗口模型：打开拉**尾部 50 条**（`PAGE_MESSAGES=50`），`loadOlder()` 每次向前翻 50 条 | `packages/client/runtime/src/client/sessions/session.ts:32,380-409` |
| `session.history` 只有 `beforeSeq/maxMessages`（向后翻页），**无 afterSeq/aroundSeq 中心寻址** | `packages/host/apiproxy/src/api/sessions.schema.ts:141-146`、`api-proxy.ts:228-256` |
| `session-query.readEvent` 支持 seq 定位 + ±before/after 窗口，但**仅 tool（tool-session-query）暴露，非浏览器 RPC** | `packages/session-query/session-query/src/index.ts:307` |
| 部署为 **JSONL 后端**（445 个 `session.jsonl.zstd`，共 477 MB）；`inspect()`/readFrom 全量解压解码 | `packages/session/session-persistence-jsonl/src/index.ts`；见 #4416 讨论 |
| sqlite 后端已有 seek 原语 `loadStoredFrom(fromSeq)`（按 seq 读后缀，O(后缀)） | `packages/session/session-persistence/src/coordinator.ts:176`、`session-persistence-sqlite/src/store.ts:160-170` |
| 插件索引**未存 messageId/step**，无法从索引直接推导锚点 key | `dsh-session-explorer/src/indexer.ts`（schema 仅 session_id/seq/kind/time/turn/text_main/text_tool） |

## 4. 可行性评估

| 方案 | 难度 | 可达 | 说明 |
|---|---|---|---|
| A. 纯插件实现 | 🔴 高 | ❌ **不可达** | 无中心寻址 RPC；无 view 切换能力（view ring 是 per-session store，插件拿不到 actions）；锚点 key 需 messageId/step，索引未存 |
| B. 插件 + 上游小补丁 | 🟡 中高 | ✅ 可达 | 见下 |
| C. 换 sqlite 持久化后端 | 🟡 中 | ✅ 可达且快 | `loadStoredFrom` 已有；但换后端 = 部署级存储迁移，影响面远超本功能 |
| D. 降级：仅定位「会话内可寻址节点」 | 🟢 低 | ⚠️ 部分 | 无锚点 API 也做不到精确跳页；只能面板内滚动 |

### 为什么纯插件不可行（硬性缺口）

1. **没有「打开会话到指定 seq」的 API**：`session.open` 无参，history 只能从尾部往前翻。
2. **没有中心寻址读取**：跳 p75（584 条）需 12 次 loadOlder、p95（2,612 条）需 53 次、最深（4,263 条）需 ~85 次；JSONL 后端每次 = 一次全量日志解压解码（最深 19.9 MB）→ 秒级~十秒级。
3. **插件拿不到 view ring / scroll 注入**：`setView`/`setInspect` 在 ui-conversation 内部 store；`chatScrollPositions` 不外露。
4. **锚点 key 需要 messageId/step**：用户消息节点 key 用全局 MessageId（事件 `data.id`），assistant 节点 key 用 `turn:step`；插件索引都没存。

## 5. 推荐路线（若实施）

### 5.1 上游贡献（Discussion 提案，非 PR）

- `session.history` 增加 `afterSeq`（或 `aroundSeq`）：以指定 seq 为中心返回一页（sqlite 后端近乎免费；jsonl 后端单次全量解码——可接受，优于 85 次翻页）。
- `session.open`（或 `sessions.open`）接受可选 `anchorSeq`，打开后窗口以锚点为中心。
- `ChatView` 支持「打开即跳转锚点」：把 `chatScroll` 注入改为可外部写入（或开放 per-session scroll position 设置）。

### 5.2 插件侧（一次发布）

- 索引增加 `message_id`、`step` 列（schema bump user_version 3→4，全量重建 859 MB 索引）；或跳转时 host 端 `inspect` 一次拿 messageId/step（免重建，但每次跳转全量解码一次）。
- Preview「打开会话」→ RPC `jumpTo({sessionId, seq})` → 上游 open 带锚点。

### 5.3 成本与风险

- 上游：2-3 个中等 commit（sqlite 后端几乎免费；jsonl 单次 decode 可接受）。
- 插件：索引列扩展或 inspect + RPC + UI ≈ 1 个 release。
- 风险：上游是否采纳（开发者预览期迭代快，已有社区补丁类 Discussion 如 #244 被认真对待）；JSONL 大会话首次跳转仍需秒级（可加 loading 态）。

## 6. 结论

**放弃「纯插件」版本**（硬性不可行）；**「插件 + 上游小补丁」可行**。上游通道 = **GitHub Discussions（Ideas 分类）**，正文附提案 + 关键源码引用 + 补丁要点（或 gist），并在 dsh-session-explorer README/讨论区引流。

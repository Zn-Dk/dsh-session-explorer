# dsh-session-explorer

> [English](./README.md) | **中文**

DSH Web 出树插件：会话消息级全文检索浏览器。检索具体到某一条消息（用户/助手/工具/系统注入四类），只读预览上下文，一键跳转真实会话。

## 功能

- **消息级全文检索** — 检索某一条具体消息：用户 / 助手 / 系统注入正文高权重，工具名、参数、错误摘要低权重。FTS5 trigram 索引支持任意子串，中文无需分词；短查询（<3 字符）自动降级为 LIKE 子串匹配。
- **四类消息** — 用户（user）/ 助手（assistant）/ 系统注入（steering，含 plugin 注入、skill-catalog、skill-invocation、compaction 摘要等）/ 工具（tool，可检索工具名、参数与错误摘要）。
- **fork/续接会话自动去重** — DSH fork/续接会话共享父历史，同一条消息会在多个会话各存一份；搜索结果按 (seq, kind, 正文) 分组去重，优先保留标题非空、更新更晚的会话。
- **只读预览** — 命中消息 + 前后上下文窗口，焦点消息自动滚动定位到可视区中央，可一键在真实会话中打开。
- **会话浏览器入口** — 侧栏工具区入口按钮 + conversation 列内覆盖面板（不遮挡全局）；面板左上角「返回会话」按钮关闭并回到会话。
- **国际化（i18n）** — 中英双语全覆盖（面板/对话框/搜索/预览），语言跟随 DSH Host locale 服务（设置页 General 切换即时生效），无手动设置项。
- **重建索引（增量/全量 + 健康检查）** — 增量模式用 engine revision token 快速 diff（O(1) 跳过未变会话）+ 内容指纹重刷变化会话 + 清理幽灵会话；全量模式清库逐会话重建。打开重建对话框时自动执行索引库健康检查（integrity + 关键表可读性）并推荐模式。
- **索引状态（损坏会话分类）** — 已索引 / 待同步 / 源日志损坏（无法索引）三态展示；打开面板时自动轻量同步（live 会话 + 未索引新会话），turn 结束增量同步，启动时对账。

## 安装

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-session-explorer
```

包页面：[https://www.npmjs.com/package/dsh-session-explorer](https://www.npmjs.com/package/dsh-session-explorer)

### 本地构建安装

```sh
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-session-explorer-*.tgz
```

安装后重启 `dsh web`，侧栏工具区出现「会话浏览器」入口。索引库位于 `~/.dsh/storages/session-explorer.sqlite`（首次使用自动创建并索引）。

## 开发

```sh
pnpm install
pnpm test      # 41 个单元测试（需要 Node ≥ 22.5，依赖 node:sqlite）
pnpm build     # tsc + rolldown client bundle
```

## 架构

- `src/protocol.ts` —— RPC 契约类型（Host/Client 共享）
- `src/transcript.ts` —— SessionEvent 日志 → 可索引消息条目的纯折叠层（零依赖、可单测）
- `src/indexer.ts` —— SQLite FTS5 trigram 派生索引（host 侧，application_id + user_version 双校验、0600 权限）
- `src/rpc.ts` —— RPC 校验与路由
- `src/index.ts` —— host 装配（事件同步 + RPC + 启动对账）
- `src/client/` —— 浏览器 bundle（侧栏入口 + 搜索/预览视图 + conversation 列内覆盖面板）

## 已知限制

- 完整 tool result 正文全文检索留待 V2（当前仅工具名/参数/错误摘要进低权重字段）。
- 会话删除无引擎 API，索引删除仅支持插件自建库内清理。
- 时间线画布（@xyflow/react）存在严重渲染 bug，0.2.0 起暂时隐藏入口，修复后恢复。

## 许可证

MIT

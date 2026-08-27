# Changelog

## [Unreleased]

### 新增
- 时间线重构为可搜索 CSS Grid 会话总览：支持主代理/子代理筛选、标题/cwd/消息摘要搜索，以及按更新时间、创建时间、消息数量排序。
- 会话卡片详情：展示会话元数据、主/子代理 lineage、首条/最近消息摘要，并支持消息摘要原位展开；不依赖原始会话锚点跳转。

### 变更
- 移除 @xyflow/react 画布、MiniMap、Controls 与横向点阵布局，改用语义化会话卡片和消息摘要列表。
- 索引 schema v3→v4：增加 parent_session_id、subagent_kind 及时间线摘要/过滤所需字段，旧库自动迁移。
- 浅色/深色主题改用明确的语义 surface、文字与边框 token，修复深色模式文字与节点背景对比不足。

本项目的所有显著变更都记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-08-24

### 新增
- 国际化（i18n）：中英双语（zh/en）全覆盖——面板 header（返回会话/消息检索/时间线）、索引状态、重建索引对话框（健康检查/增量/全量/取消/开始）、搜索结果（placeholder/种类筛选/空态/加载更多）、只读预览（返回/打开会话/命中标记）。语言跟随 DSH Host locale 服务（设置页 General 切换语言即时生效），不可用时回退浏览器语言，无手动设置项。
- 侧栏入口标签跟随语言（中文「会话浏览器」/ 英文「Session Explorer」）。

### 变更
- 「返回会话」按钮从面板右上角移至左上角（header 最左，时间线/搜索 tab 之前），与 dsh-ssh 等兄弟面板交互对齐。

## [0.2.1] - 2026-08-24

### 修复
- user/message 消息字段位置修正：内容改从 data 顶层读取（data.source / data.content），不再从 data.message 读取；分类语义对齐引擎：source.kind === 'user' → 用户消息，其余来源（plugin / skill-catalog / skill-invocation 等）统一归为系统注入（steering）。
- 搜索结果自动去重：按 (seq, kind, text_main) GROUP BY 去重，修复 fork/续接会话共享父历史导致同一条消息在多个会话重复出现。
- 只读预览：焦点消息渲染后自动滚动定位（scrollIntoView 居中），修复预览打开时焦点消息不在可视区内。
- 面板互斥：本面板打开时主动关闭兄弟面板（ssh / taskboard / mnemon 等，对齐兼容事件 + suppress 旗标防回关）；面板右上角 × 关闭按钮改为「返回会话」按钮。

## [0.2.0] - 2026-08-24

### 新增
- 重建索引改为增量/全量两级，dialog 选择：增量用 engine revision token 快速 diff（O(1) 跳过不变会话），全量清库重建修复损坏。
- 索引库健康检查（PRAGMA integrity_check + 关键表可读性），dialog 打开时自动检测并推荐模式。
- 失败会话分类：源日志损坏的会话单独标记为「无法索引」，不再伪装成「待同步」。
- 面板打开时 sync-on-open 端点（同步 live 会话 + 未索引新会话）。
- 重建索引帮助 tooltip（DSH 平台 Tooltip 组件，非 title 属性）。

### 修复
- RPC 失败信封对齐引擎 rpcResultSchema（修复「invalid client-request message / invalid_union」）。
- 已索引会话计数不再包含幽灵会话（修复 337/336 溢出）。
- 重建索引 loading 卡死：payload 归一化（undefined → {}）修复请求校验失败。

### 变更
- 索引库 schema v2→v3（新增 log_fingerprint / log_revision / error 列，自动迁移旧库）。

### 已知限制
- 完整 tool result 全文检索留待 V2（当前仅工具名/参数/错误摘要进低权重字段）。
- 会话删除无引擎 API，索引删除仅支持插件自建库内清理。
- 时间线画布（@xyflow/react）存在严重渲染 bug，0.2.0 发布版暂时隐藏入口，修复后恢复。

## [0.1.0] - 2026-08-24

### 新增
- 消息级全文搜索（user/assistant/steering 正文高权重 + 工具名/参数/错误摘要低权重，FTS5 trigram 任意子串）。
- 会话时间线画布（@xyflow/react，全部会话按时间排布，自定义节点）。
- 只读消息预览（命中消息前后上下文 + 高亮 + 在会话中打开）。
- 插件自带 SQLite 派生索引（~/.dsh/storages/session-explorer.sqlite），turn 结束增量同步 + 启动对账 + 手动重建。
- 侧栏工具入口（outline 时钟图标，与任务看板等工具并列）。

### 变更
- 面板从全屏 overlay 改为 conversation 列内覆盖（与 dsh-ssh 同构，不遮挡全局，避免 z-index 冲突）。

### 已知限制
- 完整 tool result 全文检索留待 V2（当前仅工具名/参数/错误摘要进低权重字段）。
- 会话删除无引擎 API，索引删除仅支持插件自建库内清理。

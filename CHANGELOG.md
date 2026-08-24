# Changelog

本项目的所有显著变更都记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

# Changelog

本项目的所有显著变更都记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

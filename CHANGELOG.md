# Changelog

本项目的所有显著变更都记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增
- 消息级全文搜索（user/assistant/steering 正文高权重 + 工具名/参数/错误摘要低权重，FTS5 trigram 任意子串）。
- 会话时间线画布（@xyflow/react，全部会话按时间排布，自定义节点）。
- 只读消息预览（命中消息前后上下文 + 高亮 + 在会话中打开）。
- 插件自带 SQLite 派生索引（~/.dsh/storages/session-explorer.sqlite），turn 结束增量同步 + 启动对账 + 手动重建。

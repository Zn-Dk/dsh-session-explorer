# dsh-session-explorer

DSH Web 出树插件：会话消息级全文检索 + 时间线可视化浏览器。

## 功能

- **消息级全文搜索**：检索具体某一条消息的内容（用户/助手/系统注入正文高权重；工具名、参数、错误摘要低权重）。FTS5 trigram 索引支持任意子串，中文无需分词。
- **会话时间线画布**：@xyflow/react 渲染全部会话，按工作目录分组、时间排布，一眼看清会话脉络。
- **只读消息预览**：命中消息前后上下文窗口预览，高亮定位，一键在真实会话中打开。
- **自建 SQLite 派生索引**：`~/.dsh/storages/session-explorer.sqlite`，turn 结束增量同步 + 启动对账 + 手动重建，不依赖引擎 session-query。

## 安装

```sh
pnpm pack
dsh plugin --profile web add ./dsh-session-explorer-0.1.0.tgz
```

安装后重启 `dsh web`，侧栏工具区出现「会话浏览器」入口。

## 开发

```sh
pnpm install
pnpm test      # 34 个单元测试
pnpm build     # tsc + rolldown client bundle
```

## 架构

- `src/protocol.ts` —— RPC 契约类型
- `src/transcript.ts` —— SessionEvent 日志 → 可索引消息条目的纯折叠层
- `src/indexer.ts` —— SQLite FTS5 trigram 派生索引（host 侧）
- `src/rpc.ts` —— RPC 校验与路由
- `src/index.ts` —— host 装配（事件同步 + RPC + 启动对账）
- `src/client/` —— 浏览器 bundle（侧栏入口 + 搜索/时间线/预览视图）

## License

MIT

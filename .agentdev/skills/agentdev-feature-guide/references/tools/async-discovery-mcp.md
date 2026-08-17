# 异步发现与 MCP 领域装配

## 目录

- [选择异步发现](#选择异步发现)
- [发现管线](#发现管线)
- [失败和降级](#失败和降级)
- [MCP 管理选项](#mcp-管理选项)
- [连接所有权](#连接所有权)
- [验证](#验证)

## 选择异步发现

使用 `getAsyncTools(ctx)`，当工具集合必须等待：

- 连接远端服务；
- 读取工作区配置；
- 探测本机可执行程序；
- 查询服务端能力；
- 建立 MCP 客户端并调用 `listTools()`。

工具集合固定但执行时才需要连接时，优先在 `getTools()` 声明稳定工具，在 `onInitiate()` 建立资源。稳定名称比每次启动变化的工具集合更容易让 Agent 学会使用。

## 发现管线

按固定阶段处理远端能力：

```text
load config
→ connect
→ discover
→ validate metadata
→ filter allowlist
→ map deterministic names
→ rewrite descriptions
→ attach render and execution semantics
→ detect collisions
→ return Tool[]
```

名称映射保持确定性。远端顺序变化不应改变最终名称。发生碰撞时使用稳定 server 前缀或拒绝装配，不使用依赖遍历顺序的随机后缀。

远端描述只是原材料。重写为 Agent 可理解的调用条件、限制和结果，并过滤协议实现细节。

## 失败和降级

核心会捕获 `getAsyncTools()` 异常、记录警告并继续执行后续初始化。由此要求 Feature 明确就绪状态：

```ts
type Readiness =
  | { state: 'starting' }
  | { state: 'ready'; toolCount: number }
  | { state: 'degraded'; reason: string };
```

选择策略：

- 必需服务失败：稳定工具仍存在，但返回“未就绪”错误；
- 可选 server 失败：跳过该 server，记录结构化日志；
- 全部发现失败：公开 readiness API 并避免半有效工具；
- 发现为空：区分合法空集合与配置错误。

不要在失败后留下已连接但无人管理的客户端。

## MCP 管理选项

使用受管装配 API 时，可对工具进行：

- `include` / `exclude`；
- `disable`；
- `rename`；
- `describe`；
- 全局或逐工具 `render`；
- `mapName`；
- `transformArgs`；
- `transform` 返回补丁或 `false` 过滤工具。

领域 Feature 应优先白名单高价值工具，并把原始 MCP 工具塑造成稳定领域契约：

```ts
const result = await mountMCPToolsFromConfig(config, {
  manager: this.manager,
  clients: this.clients,
  getServerOptions: serverId => ({
    include: allowedTools[serverId],
    mapName: tool => `issue_${normalizeName(tool.name)}`,
    describe: descriptions[serverId],
    transformArgs: args => normalizeArgs(args),
  }),
  onError: (serverId, error) => {
    ctx.logger.warn('MCP server unavailable', {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
  },
});
```

不要同时用通用 `MCPFeature` 和领域 Feature 挂载同一 server。

## 连接所有权

创建客户端的一方负责释放：

- 保存每个 server 的客户端；
- 记录连接成功与失败；
- `onDestroy()` 逐个 `dispose()`；
- 部分初始化失败时释放已创建客户端；
- 动态重载时先构造新集合，成功后原子替换，再清理旧集合；
- 不把客户端放进快照。

配置中的命令、环境变量、headers 和 URL 可能含敏感数据。日志只记录 server ID、传输类型、耗时和归一化错误，不记录完整配置。

## 验证

- 配置为空、合法、非法时的行为；
- 单 server 与多 server；
- 一个 server 失败时其他 server 仍可用；
- include/exclude/disable 的优先级；
- rename 后无碰撞；
- transformArgs 不修改原始参数对象；
- 工具描述和渲染覆盖生效；
- 重复发现产生相同名称集合；
- 销毁后所有 client 和 manager 均释放；
- 构建产物包含 MCP 配置样例和模板资源。

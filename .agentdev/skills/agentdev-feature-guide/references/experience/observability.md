# 日志、Inspector 与运行诊断

## 目录

- [结构化日志](#结构化日志)
- [日志字段](#日志字段)
- [Inspector](#inspector)
- [就绪与健康](#就绪与健康)
- [敏感数据](#敏感数据)
- [诊断流程](#诊断流程)

## 结构化日志

保存 `ctx.logger`，不要为 Feature 主路径使用裸 `console.log`：

```ts
async onInitiate(ctx: FeatureInitContext): Promise<void> {
  this.logger = ctx.logger;
  this.logger.info('Feature initialized', {
    toolCount: this.toolNames.size,
    mode: this.mode,
  });
}
```

Feature logger 自动携带 Agent、Feature、namespace 和 tags。hook 与工具执行还会增加 lifecycle、方法、工具名和 step 维度。

## 日志字段

统一字段：

- `operation`：稳定操作名；
- `phase`：load/connect/discover/execute/cleanup；
- `toolName`、`serverId`、`resourceId`；
- `durationMs`；
- `result`：success/degraded/blocked/failed；
- `errorCode` 和短错误信息；
- `retryAttempt`；
- `readiness`；
- `count`，而不是完整大数组。

一次失败至少能回答：在哪个 Feature、哪个阶段、哪个资源、是否可重试、下一步是什么。

## Inspector

Inspector 可显示：

- Feature name、description 和 source；
- enabled/disabled/removed/partial 状态；
- 当前工具、来源和 superseded 条目；
- render call/result；
- hook 生命周期、顺序、方法和源码位置；
- `getHookDescription()` 返回的说明。

调试工具缺失时先检查 source 和状态。hook 冲突时检查注册顺序。模板异常时检查 render 名称和模板 URL。

## 就绪与健康

为远端或后台 Feature 提供只读诊断 API：

```ts
getStatus(): Readonly<FeatureStatus> {
  return {
    readiness: this.readiness.state,
    connectedServers: this.clients.size,
    pendingEvents: this.pending.length,
    lastError: this.lastError?.code,
  };
}
```

不要暴露 client。状态字段有界、可序列化并适合 inspector 或测试读取。

## 敏感数据

禁止记录：

- token、cookie、authorization header；
- 完整环境变量；
- 用户文件正文和消息全文；
- shell 命令中的秘密参数；
- 原始 SDK 请求/响应；
- 超长 base64 或二进制。

记录哈希、长度、ID、域名和脱敏摘要。错误对象先提取安全字段。

DebugHub 只查询成功交付给 Hub 的结构化日志。Hub 未连接时的 console 回退不会自动补录。

## 诊断流程

1. 检查 Feature 是否挂载及 source；
2. 检查 readiness 和初始化日志；
3. 检查工具状态、来源和覆盖历史；
4. 检查 hook 顺序和说明；
5. 检查最近一次结构化错误；
6. 检查 Context 中实际 tool call/result；
7. 检查外部资源健康与权限；
8. 在最小配置和假客户端下复现；
9. 将复现固化为测试。

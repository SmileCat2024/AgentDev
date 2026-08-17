# 初始化、就绪状态与资源清理

## 目录

- [资源所有权](#资源所有权)
- [初始化阶段](#初始化阶段)
- [就绪模型](#就绪模型)
- [部分失败](#部分失败)
- [后台任务](#后台任务)
- [清理](#清理)
- [验证](#验证)

## 资源所有权

创建资源的一方负责释放。资源包括：

- 网络客户端和 socket；
- 数据库连接；
- 子进程和 worker；
- timer、interval 和监听器；
- MCP client/manager；
- 文件句柄和临时目录；
- 活动请求和后台 Promise。

在 Feature 字段中保存所有权，不依赖全局单例隐式存活。

## 初始化阶段

核心准备顺序为 `getTools()` → `getAsyncTools()` → `onInitiate()` → 收集 hooks。

注意：

- `getTools()` 抛错会中断整体准备；
- `getAsyncTools()` 抛错会被记录，随后仍执行 `onInitiate()`；
- `onInitiate()` 抛错会被记录，hooks 仍会被收集；
- 因此工具和 hooks 必须检查就绪状态，不能假设初始化一定成功。

将同步工具声明与资源就绪解耦：

```ts
private readiness: Readiness = { state: 'starting' };

async onInitiate(ctx: FeatureInitContext): Promise<void> {
  try {
    const client = await this.connect(ctx);
    this.client = client;
    this.readiness = { state: 'ready' };
  } catch (error) {
    this.readiness = { state: 'degraded', reason: toMessage(error) };
    throw error;
  }
}
```

## 就绪模型

```ts
type Readiness =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'degraded'; reason: string }
  | { state: 'stopping' }
  | { state: 'stopped' };
```

工具入口统一调用：

```ts
private requireClient(): RemoteClient {
  if (this.readiness.state !== 'ready' || !this.client) {
    throw new Error(`remote feature is not ready: ${this.readiness.state}`);
  }
  return this.client;
}
```

公开 API 提供只读 readiness，方便依赖 Feature 和诊断工具判断。

## 部分失败

使用事务式初始化：

1. 在局部变量创建资源；
2. 全部关键步骤成功后赋给 Feature 字段；
3. 失败时按相反顺序释放局部资源；
4. 最后更新 readiness；
5. 不暴露半初始化客户端。

多 server 或多 worker 场景记录每个子资源状态。允许部分服务可用时，工具只绑定到成功资源；不允许部分可用时，释放全部并进入 degraded。

## 后台任务

后台循环使用专属 `AbortController`：

```ts
private controller?: AbortController;
private background?: Promise<void>;

start(): void {
  this.controller = new AbortController();
  this.background = this.runLoop(this.controller.signal);
}
```

要求：

- 保存 Promise，避免无法等待；
- 循环捕获并记录单次错误；
- abort 后尽快退出；
- 事件回调不并发修改 Agent Context；
- 限制缓冲区大小和丢弃策略；
- 未处理 rejection 不得泄漏到进程级。

## 清理

`Agent.dispose()` 会等待 Feature `onDestroy()`。`removeFeature()` 触发但不等待异步清理。

让清理幂等：

```ts
async stop(): Promise<void> {
  if (this.readiness.state === 'stopped') return;
  this.readiness = { state: 'stopping' };
  this.controller?.abort();
  await this.background?.catch(() => undefined);
  await this.client?.close();
  this.client = undefined;
  this.readiness = { state: 'stopped' };
}

async onDestroy(): Promise<void> {
  await this.stop();
}
```

有严格替换边界时先 `await feature.stop()`，再 `removeFeature()`。

## 验证

- 正常初始化和就绪状态；
- 每个初始化阶段失败；
- 失败后无遗留资源；
- 未就绪工具返回明确错误；
- 后台循环响应 abort；
- stop/onDestroy 连续调用安全；
- `Agent.dispose()` 等待清理；
- 动态移除前显式 stop 能保证资源关闭；
- restoreState 不创建外部资源。

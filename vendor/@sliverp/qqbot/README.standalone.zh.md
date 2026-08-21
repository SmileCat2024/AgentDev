# QQBot 独立接入说明

这份说明面向“不使用 OpenClaw，只把 qqbot 当作 QQ 接入 SDK 使用”的场景。

## 适合什么场景

- 你已经有自己的 TS/Node 项目
- 你只想复用 QQ Bot 的鉴权、WebSocket 收消息、HTTP 发消息能力
- 你希望把收到的消息交给自己的 agent 处理

## 推荐入口

在你的项目中使用：

```ts
import {
  createQQBotAgentAdapter,
  startGateway,
  sendText,
} from "@sliverp/qqbot/standalone";
```

不要用默认入口 `@sliverp/qqbot`，因为默认入口仍然包含 OpenClaw 插件注册逻辑。

## 最小启动代码

```ts
import {
  createQQBotAgentAdapter,
  startGateway,
  type ResolvedQQBotAccount,
} from "@sliverp/qqbot/standalone";

const account: ResolvedQQBotAccount = {
  accountId: "default",
  enabled: true,
  appId: process.env.QQBOT_APP_ID || "",
  clientSecret: process.env.QQBOT_CLIENT_SECRET || "",
  secretSource: "env",
  markdownSupport: true,
  config: {
    allowFrom: ["*"],
  },
};

const adapter = createQQBotAgentAdapter(async (request) => {
  return `收到：${request.text}`;
});

await startGateway({
  account,
  cfg: {},
  abortSignal: new AbortController().signal,
  agentAdapter: adapter,
  log: console,
});
```

## 入站 / 出站形态

- 入站：QQ Gateway WebSocket 长连接
- 出站：HTTP API 单次请求

所以你的项目形态通常是：

1. 进程启动
2. `startGateway(...)` 建立长连接
3. 收到消息后回调你的处理函数
4. 你的处理函数返回文本或媒体标签
5. SDK 自动把消息发回 QQ

## 其他项目接入示例

参考目录：

- [examples/use-in-other-project/README.zh.md](/D:/code/qqbot/examples/use-in-other-project/README.zh.md)
- [examples/use-in-other-project/src/main.ts](/D:/code/qqbot/examples/use-in-other-project/src/main.ts)

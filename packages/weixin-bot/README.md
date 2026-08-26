# @agentdevjs/weixin-bot

微信 Bot feature for AgentDev - 让 Agent 获得对接微信机器人的能力。

基于腾讯官方开放的 **iLink Bot 协议**，合法稳定地接入微信个人账号。

## 特性

✅ **官方合法** - 基于腾讯官方开放的 iLink Bot API
✅ **接口一致** - 与 QQBotFeature 保持完全相同的接口设计
✅ **简单易用** - 扫码登录，长轮询接收消息
✅ **完整功能** - 支持文本/图片/语音/文件/视频等多种消息类型

## 快速开始

### 安装

```bash
npm install @agentdevjs/weixin-bot
```

### 简单测试 Demo（推荐）

这个 demo 不依赖 LLM，直接回显消息，适合快速测试：

```bash
# 1. 进入项目目录
cd C:\Users\zty0\.agentdev\feature-dev\weixin-bot

# 2. 安装依赖
npm install

# 3. 编译 TypeScript
npm run build

# 4. 运行测试 demo
node dist/examples/weixinbot-example.js
```

**运行后会：**
1. 显示登录二维码（在终端打印 URL）
2. 使用微信扫描二维码
3. 扫码成功后，向 Bot 发送任意消息
4. Bot 会自动回复（带时间戳的回显）
5. 在终端查看日志确认收发成功

### 完整 Agent 示例

如果你想体验完整的编程助手功能（需要配置 LLM）：

```bash
# 1. 配置 LLM（参考 AgentDev 文档）
# 2. 运行完整示例
node dist/examples/weixinbot-full-example.js
```

## 编程示例

### 简单回显 Bot

```typescript
import { WeixinBot } from '@agentdevjs/weixin-bot';

class SimpleEchoAgent {
  private weixinBot = new WeixinBot();

  async onCall(text: string): Promise<string> {
    return `[回显] 你说：${text}`;
  }

  use(feature: any): void {
    if (feature instanceof WeixinBot) {
      this.weixinBot = feature;
    }
  }

  async start(): Promise<void> {
    await this.weixinBot.startGateway(this);
  }
}

const agent = new SimpleEchoAgent();
await agent.start();
```

### 完整编程助手

```typescript
import { BasicAgent } from 'agentdev';
import { WeixinBot } from '@agentdevjs/weixin-bot';

const weixinBot = new WeixinBot();
const agent = new BasicAgent({ llm }).use(weixinBot);

await agent.init();
await weixinBot.startGateway(agent);
```

## 配置文件

登录后，Bot Token 会自动保存到 `.agentdev/weixin-bot.config.json`：

```json
{
  "botToken": "your-bot-token",
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "loginTime": 1234567890
}
```

下次启动时会自动使用保存的 Token，无需重新扫码。

## 接口兼容性

与 QQBotFeature 接口完全一致：

```typescript
// 之前：QQBot
const qqbot = new QQBotFeature({ appId, clientSecret });
agent.use(qqbot);
await qqbot.startGateway(agent);

// 之后：WeixinBot（只需改名！）
const weixin = new WeixinBot();
agent.use(weixin);
await weixin.startGateway(agent);
```

## 技术方案

本 Feature 基于腾讯官方开放的 **iLink Bot 协议**：

- **API 文档**：https://ilinkai.weixin.qq.com
- **认证方式**：扫码登录 + Bot Token
- **消息接收**：HTTP 长轮询（getupdates）
- **消息发送**：HTTP POST（sendmessage）
- **协议格式**：JSON

详细技术文档请参考：[weixin-bot-api.md](../weixin-bot-api.md)

## 注意事项

⚠️ **首次使用需要扫码登录**
- 运行程序后会显示二维码 URL
- 使用微信扫描二维码登录
- Bot Token 会自动保存，后续无需重新扫码

⚠️ **网络环境**
- 需要能够访问 `ilinkai.weixin.qq.com`
- 建议使用稳定的网络环境

⚠️ **合规使用**
- 遵守腾讯《微信ClawBot功能使用条款》
- 不得用于违法违规用途
- 腾讯保留限流和封禁的权利

## 开发

```bash
npm install
npm run build    # 编译
npm run dev      # 监听模式
```

## License

MIT

## 相关资源

- [iLink Bot API 文档](https://ilinkai.weixin.qq.com)
- [OpenClaw 文档](https://docs.openclaw.ai)
- [AgentDev 文档](https://github.com/your-org/agentdev)

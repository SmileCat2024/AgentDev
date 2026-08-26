# @agentdevjs/rokid-bot

Rokid 眼镜 Bot Feature for AgentDev。

让 Agent 获得对接 Rokid 眼镜的能力：通过 WebSocket 长连接到 Rokid RCS Bridge 服务，接收设备转写的用户消息并把回复回推到设备，同时提供拍照、导航、日程、退出等设备命令工具。

接口设计与 `WecomBot` / `FeishuBot` / `WeixinBot` / `QQBotFeature` 保持一致。

## 协议来源

参考 [rokid-openclaw-gateway-compatible](https://gitee.com/rokid-eco/rokid-openclaw-gateway-compatible) 项目的 `ws-bridge-service.ts` 与 `device-tools.ts`。

与原 openclaw 插件相比，本实现剥离了 openclaw 运行时抽象（`channelRuntime.routing` / `channelRuntime.session` / `channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher`），改为直接调用 agentdev 的 `agentRef.onCall`，符合 agentdev 的 Feature 接入范式。

## 配置

在项目根目录创建 `.agentdev/rokid.config.json`：

```json
{
  "linkCode": "<your-device-link-code>",
  "linkSecret": "<your-device-link-secret>",
  "wsUrl": "wss://rcs.rokid.com/claw/ws/link"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `linkCode` | 是 | 设备配对码（设备配对界面提供） |
| `linkSecret` | 是 | 设备配对密钥（设备配对界面提供） |
| `wsUrl` | 否 | WebSocket 服务端地址，默认 `wss://rcs.rokid.com/claw/ws/link` |

## 使用

```typescript
import { RokidBot } from '@agentdevjs/rokid-bot';

const rokidBot = new RokidBot({ configPath: '.agentdev/rokid.config.json' });
agent.use(rokidBot);
await rokidBot.startGateway(agent);
```

## 提供的工具

| 工具 | 说明 |
| --- | --- |
| `take_photo` | 下发拍照命令 |
| `take_navigation` | 下发导航命令（action / poi_name / navi_type） |
| `control_calendar` | 下发创建日程命令（action / title / start_time / end_time） |
| `notify_agent_off` | 下发退出对话命令 |

## 协议帧语义说明

- **入站消息**：`{ messages: MessageObject[], requestId, sessionKey? }`，由 RCS 服务端转发或 HTTP 透传（兼容 `message` / `message_id` 字段名）
- **出站回复**：先发若干个 `event=message, type=answer, is_finish=false` 的增量帧，最后发一个 `event=done, type=answer, is_finish=true` 的完成帧
- **设备命令**：`event=done, type=tool_call, is_finish=true`，按协议语义，发送后整个回合以"下发命令"终结
- **错误帧**：`{ type: "error", requestId, code, message }`

## 与 IM 渠道的差异

虽然代码架构与 IM 渠道（QQ/微信/飞书/企微）一致（同一套 Feature + startGateway 范式），但 Rokid 是"一设备一会话"模型：

- 不需要 `IMOperatorFeature` 那套线路转接工具
- 不需要 `upload_attachment`（设备协议没有媒体附件语义）
- 工具集换成的就是 4 个设备命令

## License

MIT

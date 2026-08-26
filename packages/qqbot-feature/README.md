# @agentdevjs/qqbot-feature

QQ Bot feature for AgentDev - enables QQ bot integration.

## Installation

```bash
npm install @agentdevjs/qqbot-feature
```

## Usage

```typescript
import { BasicAgent } from 'agentdev';
import { QQBotFeature } from '@agentdevjs/qqbot-feature';

const qqbotFeature = new QQBotFeature({ appId, clientSecret });
const agent = new BasicAgent({ llm }).use(qqbotFeature);

await agent.withViewer('QQBot', 2026, false);
await qqbotFeature.startGateway(agent);
```

## License

MIT

# @agentdevjs/audit-feature

> **DEPRECATED — 不再维护。** AgentDevClaw 已卸载本 Feature 的全部挂载（预制 agent、agent 生成模板、装配推荐组合），新装配不要再引入。包保留仅为历史兼容，后续可能随时移除。

Audit feature for AgentDev - tracks and logs tool usage

## Installation

```bash
npm install @agentdevjs/audit-feature
```

## Usage

```typescript
import { Audit } from '@agentdevjs/audit-feature';

const agent = new Agent({ ... }).use(new Audit());
```

## License

MIT

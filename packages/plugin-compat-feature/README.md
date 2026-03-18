# @agentdev/plugin-compat-feature

Plugin compatibility layer for AgentDev - loads OpenClaw-style plugins

## Installation

```bash
npm install @agentdev/plugin-compat-feature
```

## Usage

```typescript
import { PluginCompat } from '@agentdev/plugin-compat-feature';

const agent = new Agent({ ... }).use(new PluginCompat());
```

## License

MIT

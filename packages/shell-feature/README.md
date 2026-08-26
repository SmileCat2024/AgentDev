# @agentdevjs/shell-feature

Shell execution feature for AgentDev framework.

## Installation

```bash
npm install @agentdevjs/shell-feature
```

## Usage

```typescript
import { BasicAgent } from 'agentdev';
import { ShellFeature } from '@agentdevjs/shell-feature';

const agent = new BasicAgent().use(new ShellFeature());
```

## Features

- **Bash Execution**: Execute shell commands via Git Bash
- **Safe Trash**: Delete, list, and restore files safely with trash bin

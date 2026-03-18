# @agentdev/visual-feature

Visual understanding feature for AgentDev - provides window capture and vision model analysis.

## Installation

```bash
npm install @agentdev/visual-feature
```

## Requirements

- Python environment with pywin32, psutil, and Pillow
- OpenAI API key for vision model

## Python Setup

### Using uv (recommended)
```bash
uv pip install pywin32 psutil Pillow
```

### Using pip
```bash
pip install pywin32 psutil Pillow
```

## Usage

```typescript
import { VisualFeature } from '@agentdev/visual-feature';

// Use default python command
const agent = new Agent({ ... }).use(new VisualFeature());

// Use uv
const agent = new Agent({ ... }).use(new VisualFeature({
  pythonPath: 'uv python'
}));

// Use uv run (auto-install dependencies)
const agent = new Agent({ ... }).use(new VisualFeature({
  pythonPath: 'uv',
  pythonArgs: ['run', '--with', 'pywin32', '--with', 'psutil', '--with', 'Pillow']
}));
```

## Features

1. `capture_and_understand_window` tool - Capture window screenshot and analyze with vision model
2. `onCallStart` hook - Automatically inject current window state info

## License

MIT

# @agentdev/websearch-feature

Web search and content fetching feature for AgentDev.

## Installation

```bash
npm install @agentdev/websearch-feature
```

## Usage

```typescript
import { WebSearchFeature } from '@agentdev/websearch-feature';

const agent = new Agent({ ... }).use(new WebSearchFeature());
```

## Features

1. `web_fetch` tool - Fetch and extract content from web pages
2. Optional crawl4ai integration for enhanced web crawling

## Configuration

```typescript
import { WebSearchFeature } from '@agentdev/websearch-feature';

const agent = new Agent({ ... }).use(new WebSearchFeature({
  crawl4ai: {
    enabled: true,
    server: {
      command: 'uv',
      args: ['run', '--with', 'crawl4ai', 'python', '-m', 'crawl4ai.server']
    }
  }
}));
```

## License

MIT

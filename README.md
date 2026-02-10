# AgentDev

一个**轻量、解耦、直观**的 AI Agent 框架。

## 项目结构

```
AgentDev/
├── src/
│   ├── core/        # 核心模块
│   │   ├── types.ts
│   │   ├── message.ts
│   │   ├── context.ts
│   │   ├── tool.ts
│   │   ├── loop.ts
│   │   ├── agent.ts
│   │   └── config.ts
│   ├── llm/
│   │   └── openai.ts
│   └── index.ts
├── config/
│   └── default.json
├── examples/
│   └── agent.ts     # 基础 Agent 示例
└── test.ts          # 快速测试
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

编辑 `config/default.json`：

```json
{
  "model": {
    "provider": "openai",
    "name": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "${OPENAI_API_KEY}"
  },
  "agent": {
    "maxTurns": 10
  }
}
```

### 3. 运行

```bash
# 测试配置（无需 API Key）
npx tsx test.ts

# 运行 Agent（需要 OPENAI_API_KEY）
OPENAI_API_KEY=sk-xxx npm run agent
```

## 使用示例

```typescript
import { Agent, createTool, createOpenAILLM, loadConfig } from './src/index.js';

// 创建工具
const calc = createTool({
  name: 'calculator',
  description: '计算表达式',
  execute: async ({ expression }) => String(eval(expression)),
});

// 创建 Agent
const config = await loadConfig();
const llm = createOpenAILLM(config.model.apiKey, config.model.name);

const agent = new Agent({
  llm,
  tools: [calc],
  maxTurns: 10,
});

// 运行
const result = await agent.run('25 * 4 是多少？');
console.log(result);
```

## API

| 函数 | 说明 |
|------|------|
| `loadConfig(name?)` | 从 `config/` 加载配置 |
| `createTool(config)` | 创建工具 |
| `createOpenAILLM(key, model, url?)` | 创建 OpenAI LLM |
| `new Agent(config)` | 创建 Agent |
| `agent.run(input)` | 运行 Agent |

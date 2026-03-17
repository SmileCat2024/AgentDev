# @agentdev/create-feature

CLI tool to create AgentDev Feature packages with zero configuration.

## Usage

### 方式1：从 AgentDev 项目创建（推荐）

```bash
# 在 AgentDev 项目根目录
npm run create-feature my-feature

# Feature 会被创建在当前目录下
# my-feature/
```

### 方式2：直接运行 CLI

```bash
# 在任何目录下
node /path/to/AgentDev/packages/create-feature/dist/cli.js my-feature
```

### 方式3：在 packages/ 目录下创建

```bash
# 进入你的项目的 packages 目录
cd /your/project/packages

# 运行 CLI（需要指定完整路径）
node /path/to/AgentDev/packages/create-feature/dist/cli.js my-feature
```

## What Gets Created

The CLI creates a complete Feature package with:

```
my-feature/
├── package.json          # Configured with tsup
├── tsconfig.json         # TypeScript configuration
├── README.md             # Documentation
└── src/
    ├── index.ts          # Feature class (with getPackageInfo + getTemplateNames)
    ├── types.ts          # Type definitions
    ├── tools.ts          # Tool creation functions
    ├── templates/        # Template source files
    │   └── *.render.ts
    └── python/           # Python scripts (auto-copied to dist)
```

## Key Features

### ✅ Zero Configuration for Resources

No need to write copy-assets.mjs scripts! The generated `package.json` includes:

```json
{
  "tsup": {
    "assets": [
      "src/**/*.py",    // Python scripts
      "src/**/*.json",  // Config files
      "src/**/*.txt",   // Text files
      "src/**/*.md"     // Documentation
    ]
  }
}
```

Just add your files to `src/` and run `npm run build` - tsup handles everything.

### ✅ New Template System

Generated Feature uses the modern template system:

```typescript
// ✅ New way (what the CLI generates)
getPackageInfo(): PackageInfo | null
getTemplateNames(): string[]

// ❌ Old way (completely removed)
getTemplatePaths(): Record<string, string>  // DELETED
```

### ✅ Standalone Development

Works perfectly without any main project:

```bash
mkdir my-feature
cd my-feature
npm init agentdev-feature my-feature
npm install
npm run build  # Works entirely in this directory
```

## Development Workflow

```bash
# 1. Create feature
npm init agentdev-feature my-cool-feature
cd my-cool-feature

# 2. Install dependencies
npm install

# 3. Write your code
# Edit src/index.ts, src/tools.ts, etc.

# 4. Build
npm run build

# 5. Watch mode (optional)
npm run dev

# 6. Publish
npm publish
```

## Using the Created Feature

```typescript
import { Agent } from 'agentdev';
import { MyCoolFeature } from '@agentdev/my-cool-feature';

const agent = new Agent({
  // ... config
}).use(new MyCoolFeature());
```

## Custom Resource Types

If you need to copy other file types, just add to the `assets` array in `package.json`:

```json
{
  "tsup": {
    "assets": [
      "src/**/*.py",
      "src/**/*.json",
      "src/**/*.txt",
      "src/**/*.md",
      "src/**/*.csv"     // ← Add your type
    ]
  }
}
```

## License

MIT

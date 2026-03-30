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
├── package.json          # Build/publish scripts
├── tsconfig.json         # TypeScript configuration
├── tsup.config.ts        # Dynamic tsup entry discovery
├── README.md             # Documentation
├── skills/               # Optional skills shipped with the Feature
├── scripts/
│   └── copy-assets.mjs   # Copies non-TS assets and skills into dist/
└── src/
    ├── index.ts          # Minimal Feature class skeleton
    └── templates/        # Optional tool render templates
        └── *.render.ts
```

## Key Features

### ✅ Templates Are Optional

The generated `tsup.config.ts` only includes template entries when `src/templates/*.render.ts` actually exists, so a brand-new Feature package builds cleanly without placeholder templates.

### ✅ Asset Copying Included

The scaffold includes `scripts/copy-assets.mjs` and runs it after `tsup`, so non-TypeScript resources like `.py`, `.json`, `.md`, or image/audio files can live under `src/` and be copied into `dist/`.

If you add a package-root `skills/` directory, the same script also copies it into `dist/skills/`, so standalone Feature packages can ship skills in a form that AgentDev discovers automatically after install.

### ✅ Current Tool Schema

Generated Feature uses the modern template system:

```typescript
// Feature metadata
getPackageInfo(): PackageInfo | null
getTemplateNames(): string[]

// Tool definitions should use:
parameters: {
  type: 'object',
  properties: {}
}
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
# Edit src/index.ts and add optional files under src/templates/, other src subfolders, or package-root skills/ as needed.

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

If you need to copy other file types, extend `ASSET_EXTENSIONS` in `scripts/copy-assets.mjs`.

## License

MIT

# 工程结构与 TypeScript 基线

## 目录

- [推荐目录](#推荐目录)
- [入口文件](#入口文件)
- [编译配置](#编译配置)
- [公开导出](#公开导出)
- [资源路径](#资源路径)
- [结构检查](#结构检查)

## 推荐目录

```text
my-feature/
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── config.ts
│   ├── service.ts
│   ├── client.ts
│   ├── tools/
│   │   ├── read.ts
│   │   └── write.ts
│   └── templates/
│       └── item-read.render.ts
├── skills/
│   └── use-items/SKILL.md
├── test/
│   ├── unit/
│   └── integration/
├── scripts/
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

框架内 Feature 可放在 `src/features/<name>/`，测试放在该目录的 `test/`。独立包保持 `src/` 为唯一源码根。

## 入口文件

`src/index.ts` 只承担：

- 导出 Feature 类和公开类型；
- 组合工具、服务和资源；
- 实现 `AgentFeature` 接口；
- 声明 `source`、`name` 和 `description`。

不要把全部 schema、SDK 调用、HTML 和迁移逻辑堆在入口文件。

```ts
import { fileURLToPath } from 'url';
import type { AgentFeature } from 'agentdev';

export class ItemFeature implements AgentFeature {
  readonly name = 'item';
  readonly description = '查询和修改工作区中的条目。';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
}
```

## 编译配置

使用 ESM、严格类型和声明文件：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

测试和构建应使用同一套模块解析语义。

内部相对导入在 ESM 源码中使用构建后的 `.js` 扩展：

```ts
import { createReadTool } from './tools/read.js';
```

## 公开导出

只导出消费方需要的契约：

```ts
export { ItemFeature } from './item-feature.js';
export type {
  ItemFeatureConfig,
  ItemFeatureApi,
  ItemSummary,
} from './types.js';
```

避免导出内部客户端、可变状态类型、测试 helper 和实现专用错误细节。公开 API 的返回类型应稳定、可序列化并与包根可导入类型组成。

## 资源路径

- 用户文件以 `workspaceDir` 为基准；
- 包资源以 `source` 推导的 package root 为基准；
- 不依赖调用方的 `process.cwd()` 定位模板和 skills；
- 使用 `fileURLToPath(import.meta.url)` 处理 ESM 文件位置；
- Windows 上不要手工截取 `file://` 字符串。

模板、skills、脚本、媒体和配置样例必须显式进入构建产物。TypeScript 编译不会自动复制非 TS 文件。

## 结构检查

- 入口文件是否只负责装配？
- 领域服务能否脱离 Agent 单测？
- 每个工具文件是否只包含一个紧密相关工具族？
- 配置默认值是否只有一个定义源？
- 公开类型是否从包根导出？
- 构建产物是否包含静态资源（tsup + copy-assets）？
- 所有相对 ESM 导入是否使用 `.js`？
- 构建后目录是否保留模板和 skills 所需相对结构？

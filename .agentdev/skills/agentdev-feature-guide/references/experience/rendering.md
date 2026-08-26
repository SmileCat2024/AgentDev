# 工具渲染与模板交付

## 目录

- [渲染模型](#渲染模型)
- [模板名称引用](#模板名称引用)
- [Feature 模板文件](#feature-模板文件)
- [包信息与模板名称](#包信息与模板名称)
- [内联模板](#内联模板)
- [选择模板方式](#选择模板方式)
- [安全与可读性](#安全与可读性)
- [构建产物](#构建产物)
- [排查顺序](#排查顺序)

## 渲染模型

工具渲染分为两部分：

- `call`：展示 Agent 调用工具时的参数；
- `result`：展示工具完成后的结果。

工具通过 `render` 选择模板：

```ts
render: {
  call: 'record-update',
  result: 'record-update',
}
```

或使用简写：

```ts
render: 'record-update'
```

简写表示 call 和 result 使用同一个模板模块。

工具名和模板名是两个独立标识：

- 工具名：`record_update`；
- 模板名：`record-update`；
- 文件名：`record-update.render.ts`。

这种命名是推荐约定，不是自动转换规则。

## 模板名称引用

适合可复用 Feature 和独立调试宿主。完整链路：

```text
Tool.render 使用模板名
→ Feature.getTemplateNames() 声明模板名
→ Feature.getPackageInfo() 提供包根
→ 构建生成 *.render.js
→ Viewer 按模板 URL 加载
```

工具和 Feature 必须使用完全相同的模板名。

## Feature 模板文件

```ts
import type { InlineRenderTemplate } from 'agentdev';

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

const recordUpdateRender = {
  call: (args: Record<string, unknown>) => `
    <div class="tool-call">
      更新记录 <code>${escapeHtml(args.id)}</code>
    </div>
  `,
  result: (data: Record<string, unknown>, success?: boolean) => success
    ? `<div class="tool-result">已更新 ${escapeHtml(data.id)}</div>`
    : `<div class="tool-error">${escapeHtml(data.error ?? '更新失败')}</div>`,
} as const satisfies InlineRenderTemplate;

export default recordUpdateRender;
```

Feature 模板使用 `export default`。模板函数接收：

- call 函数：工具参数；
- result 函数：工具结果和成功标志。

先确认工具真实返回结构，再访问结果字段。

## 包信息与模板名称

```ts
import { fileURLToPath } from 'url';
import {
  getPackageInfoFromSource,
  type PackageInfo,
} from 'agentdev';

const source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

class RecordFeature {
  readonly source = source;
  private packageInfo: PackageInfo | null = null;

  getPackageInfo(): PackageInfo | null {
    if (!this.packageInfo) {
      this.packageInfo = getPackageInfoFromSource(this.source);
    }
    return this.packageInfo;
  }

  getTemplateNames(): string[] {
    return ['record-update'];
  }
}
```

Viewer 根据包类型生成 URL：

```text
独立 @agentdevjs 包:
/template/@agentdevjs/record-feature/record-update.render.js

@agentdevjs/core 内置 Feature:
/template/@agentdevjs/core/record/record-update.render.js
```

`getTemplateNames()` 返回不带 `.render.js` 的名称。

## 内联模板

内联模板直接放进 `Tool.render`，适合少量、无需文件交付的模板。

```ts
import type { InlineRenderTemplate } from 'agentdev';

const inlineTemplate = {
  call: (args: Record<string, unknown>) =>
    `<div>${escapeHtml(args.id)}</div>`,
  result: (data: Record<string, unknown>, success?: boolean) =>
    `<div class="${success ? 'tool-result' : 'tool-error'}">${escapeHtml(data.message)}</div>`,
} satisfies InlineRenderTemplate;

createTool({
  name: 'record_ping',
  description: '检查记录服务是否可用。',
  render: {
    call: inlineTemplate,
    result: inlineTemplate,
  },
  execute: async () => ({ message: 'ok' }),
});
```

`getRenderTemplates()` 可以把模板对象按名称暴露给会主动读取该方法的宿主。默认包模板交付仍使用 `getPackageInfo()` + `getTemplateNames()`；默认工具内联展示直接使用 `Tool.render`。

## 选择模板方式

使用包模板，当：

- Feature 会作为 npm 包复用；
- 调试宿主和 Agent 可能在不同进程；
- 模板较多，需要独立文件维护；
- 希望构建产物可检查。

使用内联模板，当：

- 模板非常小；
- Feature 只在同进程查看器中使用；
- 不需要独立模板资源交付。

不使用自定义模板，当 JSON 已足够清楚。不要为了形式统一给每个工具写一层无信息增益的 HTML。

## 安全与可读性

- 对所有动态文本执行 HTML 转义。
- 不拼接用户提供的原始 HTML。
- 不在模板中执行外部请求或修改状态。
- 不把密钥、令牌或完整敏感参数展示出来。
- 长文本做折叠、摘要或截断。
- 错误状态与成功状态使用明确不同的样式。
- 让 call 展示“准备做什么”，result 展示“发生了什么”。
- 模板只负责展示，不修正工具结果结构。

## 构建产物

模板文件必须作为构建入口产生可执行 JavaScript。独立包常用 `tsup.config.ts` 动态发现：

```ts
import { globSync } from 'glob';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', ...globSync('src/templates/*.render.ts')],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

期望产物：

```text
dist/
├── index.js
└── templates/
    └── record-update.render.js
```

模板引用、构建入口、发布文件列表和资源复制的完整规则使用 `agentdev-feature-packaging` 技能。

## 排查顺序

1. 检查工具 `render.call` / `render.result`。
2. 检查模板名是否完全一致。
3. 检查 `getTemplateNames()` 是否包含该名称。
4. 检查 `getPackageInfo()` 的包名和根目录。
5. 检查 `dist/templates/*.render.js` 是否存在。
6. 检查模板是否 `export default`。
7. 检查宿主请求的模板 URL。
8. 检查模板访问的参数和结果字段是否真实存在。
9. 检查动态值是否被正确转义。
10. 重建并重启持有模板缓存的调试宿主。

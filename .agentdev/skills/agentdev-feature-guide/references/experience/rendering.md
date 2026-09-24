# 工具渲染与模板交付

## 目录

- [渲染模型](#渲染模型)
- [模板名称引用](#模板名称引用)
- [Feature 模板文件](#feature-模板文件)
- [包信息与模板名称](#包信息与模板名称)
- [声明规则](#声明规则)
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

模板渲染发生在浏览器端（Claw 前端与 DebugHub 查看器两条管线）。完整链路：

```text
Tool.render 使用模板名
→ Feature.getTemplateNames() 声明模板名
→ Feature.getPackageInfo() 提供包根
→ 构建生成 dist/templates/*.render.js
→ ViewerWorker 注册装载条目（磁盘校验，缺失条目被剔除并告警）
→ 浏览器按 FEATURE_TEMPLATE_MAP 解析模板名并加载
```

工具和 Feature 必须使用完全相同的模板名。

硬边界：`Tool.render` 的模板配置经 inspector 序列化跨进程到达浏览器，只有模板名字符串能存活。不存在内联模板对象通道，框架也不读取 `getRenderTemplates()`。声明了模板名就必须走上面的文件模板链路；名字没有任何注册来源时，浏览器控制台会持续告警 `Template "..." not found in FEATURE_TEMPLATE_MAP`，并按 JSON 兜底渲染。

## Feature 模板文件

```ts
import type { InlineRenderTemplate } from '@agentdevjs/core';

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
} from '@agentdevjs/core';

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

模板 URL 由 ViewerWorker 从注册事实生成（`/tpl/{mountId}/{rel}`，mountId 由装载根目录哈希而来），对前端不透明：前端不做任何本地路径推断，只查 FEATURE_TEMPLATE_MAP。

`getTemplateNames()` 返回不带 `.render.js` 的名称。

## 声明规则

- 不需要自定义渲染就不要声明 `render`：浏览器默认按 JSON 渲染，零维护成本。不要为了形式统一给每个工具写一层无信息增益的 HTML。
- 自定义渲染只有一条交付路径：模板文件（`src/templates/*.render.ts` → `dist/templates/*.render.js`）+ `getTemplateNames()` + `getPackageInfo()`。缺少任何一环，模板名在浏览器端都无法解析。
- 模板较多时按工具语义拆分文件；一个模板名对应一个 `.render.ts` 文件。

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

框架对两种装载布局做探测：独立包用 `dist/templates/`；`@agentdevjs/core` 内置 Feature 用 `dist/features/<featureName>/templates/`（随框架 monorepo 构建产出）。

模板引用、构建入口、发布文件列表和资源复制的完整规则使用 `agentdev-feature-packaging` 技能。

## 排查顺序

浏览器控制台出现 `Template "..." not found in FEATURE_TEMPLATE_MAP` 告警时，说明某工具声明的模板名没有注册来源，按序检查：

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

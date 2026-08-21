/**
 * Feature 模板可解析性回归测试。
 *
 * 背景（2026-08-21 事故）：四包拆分后 @agentdev/core 被模板 URL 生成端
 * 误判为"单 feature 独立包"，导致 read/write/task-* 等核心渲染模板
 * 全部 404，前端静默降级为 JSON 渲染。构建与服务端均无报错，只有
 * 浏览器里能观察到——这类"声明 ↔ 文件"失联必须由测试当场拦住。
 *
 * 断言两层契约：
 * 1. 每个 feature 的 getTemplateNames() 声明的模板，必须真实存在于该包
 *    dist 的两种布局之一：
 *      - 框架包布局：dist/features/<feature>/templates/<name>.render.js
 *      - 独立包布局：dist/templates/<name>.render.js
 * 2. 反向：dist 布局目录里的每个 .render.js 都被某个声明覆盖（防死文件）。
 *
 * 运行前提：包已构建（npm run build）。CI 中测试排在 build 之后。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(pkgRoot, 'dist');

// 与 src/index.ts 导出面保持一致：需要检查的内置 feature。
// 新增带模板的内置 feature 时在此登记（静态 import，vite 禁变量动态导入）。
import { ExampleFeature } from '../src/features/example-feature/index.js';
import { OpencodeBasicFeature } from '../src/features/opencode-basic/index.js';
import { SkillFeature } from '../src/features/skill/index.js';
import { SubAgentFeature } from '../src/features/subagent/index.js';
import { TodoFeature } from '../src/features/todo/index.js';

const BUILTIN_FEATURES = [
  ['example-feature', ExampleFeature],
  ['opencode-basic', OpencodeBasicFeature],
  ['skill', SkillFeature],
  ['subagent', SubAgentFeature],
  ['todo', TodoFeature],
] as const;

function templateLayout(featureName) {
  const withFeature = join(distDir, 'features', featureName, 'templates');
  if (existsSync(withFeature)) return { kind: 'framework', dir: withFeature };
  const flat = join(distDir, 'templates');
  if (existsSync(flat)) return { kind: 'standalone', dir: flat };
  return null;
}

test('core 包 dist 已构建（本测试依赖构建产物）', () => {
  assert.ok(
    existsSync(join(distDir, 'index.js')),
    'packages/core/dist 不存在：先运行 npm run build'
  );
});

for (const [featureName, FeatureClass] of BUILTIN_FEATURES) {
  test(`[${featureName}] getTemplateNames() 声明的模板全部存在于 dist`, () => {
    const instance = new FeatureClass();
    const names = instance.getTemplateNames();
    assert.ok(Array.isArray(names) && names.length > 0, 'getTemplateNames() 应返回非空数组');

    const layout = templateLayout(featureName);
    assert.ok(layout, `${featureName} 在 dist 中没有任何模板布局目录`);

    for (const name of names) {
      const file = join(layout.dir, `${name}.render.js`);
      assert.ok(
        existsSync(file),
        `模板 "${name}" 声明了但文件不存在: ${file}（布局=${layout.kind}）`
      );
    }
  });

  test(`[${featureName}] dist 模板文件全部被声明覆盖（无死文件）`, () => {
    const layout = templateLayout(featureName);
    if (!layout || layout.kind !== 'framework') return; // 独立包布局可能混放多 feature 文件，只查框架布局

    const declared = new Set(new FeatureClass().getTemplateNames());
    const files = readdirSync(layout.dir)
      .filter((f) => f.endsWith('.render.js'))
      .map((f) => f.replace('.render.js', ''));

    for (const file of files) {
      assert.ok(
        declared.has(file),
        `dist 中存在未被 getTemplateNames() 声明的模板: ${file}（死文件或漏声明）`
      );
    }
  });
}

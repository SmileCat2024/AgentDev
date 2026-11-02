/**
 * Feature 模板可解析性回归测试。
 *
 * 背景（2026-08-21 事故）：四包拆分后 @agentdevjs/core 被模板 URL 生成端
 * 误判为"单 feature 独立包"，导致 read/write/task-* 等核心渲染模板
 * 全部 404，前端静默降级为 JSON 渲染。构建与服务端均无报错，只有
 * 浏览器里能观察到——这类"声明 ↔ 文件"失联必须由测试当场拦住。
 *
 * 断言契约（2026-08-22 mount 协议收敛后）：
 * 1. 每个 feature 的 getTemplateNames() 声明的模板，必须真实存在于该包
 *    dist 的两种布局之一：
 *      - 框架包布局：dist/features/<feature>/templates/<name>.render.js
 *      - 独立包布局：dist/templates/<name>.render.js
 * 2. 反向：dist 布局目录里的每个 .render.js 都被某个声明覆盖（防死文件）。
 * 3. 模板产物内的相对 import（tsup 共享 chunk 等）目标必须存在于磁盘。
 *    资源读取协议下 URL = /res/{agentId}/{rootId}/{rel}（ADR-0038），根内
 *    磁盘层级与 URL 层级同构，磁盘可达即 URL 可达；若此断言失败，浏览器
 *    加载模板时其依赖链会静默 404（2026-08-21 二次事故）。
 * 4. 注册载荷闭环：模拟 agent.ts 的资源根探测逻辑构造
 *    { rootCount, entries }，每个 entry 的 join(roots[root], rel) 必须存在
 *    ——这是 runtime resource.fetch handler 解析的同款路径，从生成端提前锁定。
 *
 * 运行前提：包已构建（npm run build）。CI 中测试排在 build 之后。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
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

test('dist 模板的相对 import 依赖全部存在（chunk 依赖链完整性）', () => {
  const templateFiles: string[] = [];
  const featuresDir = join(distDir, 'features');
  if (existsSync(featuresDir)) {
    for (const feature of readdirSync(featuresDir)) {
      const dir = join(featuresDir, feature, 'templates');
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.render.js')) templateFiles.push(join(dir, f));
      }
    }
  }
  const flatDir = join(distDir, 'templates');
  if (existsSync(flatDir)) {
    for (const f of readdirSync(flatDir)) {
      if (f.endsWith('.render.js')) templateFiles.push(join(flatDir, f));
    }
  }
  assert.ok(templateFiles.length > 0, 'dist 中未发现任何模板文件');

  for (const file of templateFiles) {
    const content = readFileSync(file, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^(?:import|export)\s+(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/);
      if (!m) continue;
      const spec = m[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue; // 裸包名走 node_modules，不在本断言范围
      const target = join(dirname(file), spec);
      assert.ok(
        existsSync(target),
        `模板 ${relative(distDir, file)} 的相对依赖 "${spec}" 不存在: ${target}（浏览器加载模板时其依赖链会 404）`
      );
    }
  }
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

test('注册载荷闭环：模拟 agent.ts 资源根探测，每个 entry 在其资源根下真实存在', () => {
  // 复刻 src/core/agent.ts start() 的载荷构造逻辑（探测顺序 / realpath /
  // rel 分隔符归一），agent.ts 变更时需同步此处。
  const resourceRoots: string[] = [];
  const templateEntries: Record<string, { root: number; rel: string }> = {};

  for (const [featureName, FeatureClass] of BUILTIN_FEATURES) {
    const feature: any = new FeatureClass();
    const pkgInfo = feature.getPackageInfo();
    const templateNames: string[] = feature.getTemplateNames();
    if (!pkgInfo || templateNames.length === 0) continue;

    let rootAbs: string;
    try {
      rootAbs = realpathSync(pkgInfo.root);
    } catch {
      continue;
    }
    let rootId = resourceRoots.indexOf(rootAbs);
    if (rootId < 0) {
      resourceRoots.push(rootAbs);
      rootId = resourceRoots.length - 1;
    }

    for (const templateName of templateNames) {
      const candidates = [
        join(pkgInfo.root, 'dist', 'templates', `${templateName}.render.js`),
        join(pkgInfo.root, 'dist', 'features', featureName, 'templates', `${templateName}.render.js`),
      ];
      const templatePath = candidates.find((p) => existsSync(p));
      if (!templatePath) continue;
      templateEntries[templateName] = {
        root: rootId,
        rel: relative(rootAbs, realpathSync(templatePath)).split(sep).join('/'),
      };
    }
  }

  assert.ok(Object.keys(templateEntries).length > 0, '注册载荷应包含至少一个模板条目');

  // runtime resource.fetch handler 解析的同款路径：join(roots[root], rel) 必须命中磁盘
  for (const [templateName, entry] of Object.entries(templateEntries)) {
    assert.ok(
      entry.root >= 0 && entry.root < resourceRoots.length,
      `模板 "${templateName}" 的 rootId 越界: ${entry.root}`
    );
    const root = resourceRoots[entry.root];
    const target = join(root, entry.rel);
    assert.ok(
      existsSync(target),
      `模板 "${templateName}" 的注册条目不可达: root=${root} rel=${entry.rel}`
    );
  }
});

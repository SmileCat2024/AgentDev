#!/usr/bin/env node
// 依赖纪律检查器：ghost deps（import 了但未声明）/ unused deps（声明了但从未 import）
// 用法：node scripts/dep-audit.mjs；有发现时退出码 1（可挂 CI）
// 约定：测试文件（*/test/*、*.test.*）不参与扫描——它们合法使用 root devDeps；
//      @types/* 是环境类型不计 unused；注释行（* 或 // 开头）不计 import。
// 文件级豁免：文件头部含 `dep-audit-ignore-file` 注释的整文件跳过——
//      用于脚手架模板生成器（import 语句是生成产物字符串）与 vendored 上游代码
//      （存在但不可达的 import）。豁免必须附带理由。
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { builtinModules } from 'module';

const root = 'D:/code/AgentDev/packages';
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const isTestFile = (f) => /(^|\/)test\//.test(f) || /\.test\.[cm]?[jt]s$/.test(f);

let dirty = false;

for (const dir of readdirSync(root)) {
  const pjPath = join(root, dir, 'package.json');
  if (!existsSync(pjPath)) continue;
  const p = JSON.parse(readFileSync(pjPath, 'utf8'));
  const declared = new Set([
    ...Object.keys(p.dependencies ?? {}),
    ...Object.keys(p.peerDependencies ?? {}),
  ]);

  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !isTestFile(f)) files.push(f);
    }
  };
  for (const sd of ['src', 'scripts']) {
    const d = join(root, dir, sd);
    if (existsSync(d)) walk(d);
  }

  const imported = new Set();
  const typeImported = new Set();
  const normalize = (spec) =>
    spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  const re =
    /from\s+['"]([^'"$]+)['"]|import\s*\(\s*['"]([^'"$]+)['"]\)|require\s*\(\s*['"]([^'"$]+)['"]\)|^import\s+['"]([^'"$]+)['"]/gm;
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    if (raw.includes('dep-audit-ignore-file')) continue;
    // 跨行 import/export type {...} from '...' 块整块移除并记录（类型导入不构成
    // 运行时依赖，但计入“已使用”——类型依赖仍是真实构建依赖）
    const typeBlockRe = /(import|export)\s+type\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g;
    let c0 = raw.replace(typeBlockRe, (_m, _kw, spec) => {
      typeImported.add(normalize(spec));
      return '';
    });
    // 只扫代码行：剥掉注释行（JSDoc 示例 * import / 行注释 // import）
    // 与残留的单行类型导入（import type X from '...'）
    const c = c0
      .split('\n')
      .filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l) && !/^\s*(import|export)\s+type\b/.test(l))
      .join('\n');
    let m;
    while ((m = re.exec(c))) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
      const pkg = normalize(spec);
      if (builtins.has(pkg) || pkg.startsWith('node:')) continue;
      imported.add(pkg);
    }
  }

  const ghost = [...imported].filter((x) => !declared.has(x));
  const used = new Set([...imported, ...typeImported]);
  const unused = [...declared].filter((x) => !used.has(x) && !x.startsWith('@types/'));

  if (ghost.length || unused.length) {
    dirty = true;
    console.log(`## ${p.name}`);
    if (ghost.length) console.log(`  GHOST(用了未声明): ${ghost.join(', ')}`);
    if (unused.length) console.log(`  UNUSED(声明未import): ${unused.join(', ')}`);
  }
}

console.log(dirty ? '\n依赖纪律检查未通过' : '依赖纪律检查通过：无 ghost / unused 依赖');
process.exit(dirty ? 1 : 0);

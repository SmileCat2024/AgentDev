/**
 * 创建 AgentDev Feature 包 - 最简化版本
 *
 * 只创建基础的文件夹结构和必要的文件
 * 不生成详细的示例代码
 */

import { mkdirSync, writeFileSync, existsSync as fsExistsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep generated Feature projects on the framework version that the scaffold
// itself was built and tested against. An unconstrained `latest` type surface
// can disagree with the runtime used by Studio or other consumers.
// Feature 包依赖 `@agentdev/core`（ADR-0003 决策 2，票 010）。版本与锁步组对齐。
const AGENTDEV_COMPAT_VERSION = '^0.3.0';

export interface CreateFeatureProjectOptions {
  /** npm package name, with or without the @agentdev/ scope. */
  featureName: string;
  /** Parent directory for the generated package. Defaults to process.cwd(). */
  parentDir?: string;
}

/**
 * Create a standard AgentDev Feature package without invoking a shell.
 * The caller owns dependency installation and any subsequent build.
 */
export async function createFeatureProject(options: CreateFeatureProjectOptions): Promise<{ packageName: string; featureSlug: string; targetDir: string }> {
  const featureName = String(options?.featureName || '').trim();
  if (!featureName) throw new Error('Feature name is required.');
  const packageName = featureName.startsWith('@agentdev/')
    ? featureName
    : `@agentdev/${featureName}`;
  const featureClass = toPascalCase(featureName.replace('@agentdev/', ''));
  const featureSlug = toKebabCase(featureName.replace('@agentdev/', ''));
  const targetDir = join(options.parentDir || process.cwd(), featureSlug);

  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }

  mkdirSync(join(targetDir, 'src'), { recursive: true });
  mkdirSync(join(targetDir, 'src', 'templates'), { recursive: true });
  mkdirSync(join(targetDir, 'scripts'), { recursive: true });
  generatePackageJson(targetDir, packageName, featureSlug);
  generateTsConfig(targetDir);
  generateTsupConfig(targetDir);
  generateCopyAssetsScript(targetDir);
  generateMinimalFeatureClass(targetDir, featureClass, featureSlug);
  generateMinimalReadme(targetDir, packageName, featureSlug);
  return { packageName, featureSlug, targetDir };
}

/** Legacy CLI entry point. */
export async function createFeature(featureName: string): Promise<void> {
  const result = await createFeatureProject({ featureName });
  console.log(`Creating AgentDev Feature: ${result.packageName}`);
  console.log(`Target directory: ${result.targetDir}`);
  console.log('\nFeature package created successfully!');
  console.log('\nNext steps:');
  console.log(`  cd ${result.featureSlug}`);
  console.log('  npm install');
  console.log('  # Edit src/index.ts to implement your feature');
  console.log('  npm run build');
}

/**
 * 生成 package.json
 */
function generatePackageJson(targetDir: string, packageName: string, featureSlug: string): void {
  const packageJson = {
    name: packageName,
    version: '0.1.0',
    description: `${featureSlug} feature for AgentDev`,
    type: 'module',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    files: ['dist', 'README.md'],
    scripts: {
      build: 'tsup && npm run copy-assets',
      dev: 'tsup --watch',
      'copy-assets': 'node scripts/copy-assets.mjs',
      prepublishOnly: 'npm run build'
    },
    peerDependencies: {
      '@agentdev/core': AGENTDEV_COMPAT_VERSION
    },
    devDependencies: {
      '@types/node': '^20.11.0',
      tsup: '^8.3.5',
      typescript: '^5.3.3',
      '@agentdev/core': AGENTDEV_COMPAT_VERSION
    },
    keywords: ['agentdev', 'feature', featureSlug],
    license: 'MIT'
  };

  writeFileSync(join(targetDir, 'package.json'), JSON.stringify(packageJson, null, 2));
}

/**
 * 生成 tsconfig.json
 */
function generateTsConfig(targetDir: string): void {
  const tsConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      outDir: './dist',
      rootDir: './src',
      declaration: true,
      sourceMap: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      allowSyntheticDefaultImports: true
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist']
  };

  writeFileSync(join(targetDir, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));
}

/**
 * 生成 tsup.config.ts
 * 仅在模板文件真实存在时才把它们加入 entry，避免空模板目录导致构建报错。
 */
function generateTsupConfig(targetDir: string): void {
  const content = `import { existsSync, readdirSync } from 'fs';
import { defineConfig } from 'tsup';

function getTemplateEntries(): string[] {
  const templateDir = 'src/templates';
  if (!existsSync(templateDir)) {
    return [];
  }

  return readdirSync(templateDir)
    .filter((name) => name.endsWith('.render.ts'))
    .map((name) => \`\${templateDir}/\${name}\`);
}

export default defineConfig({
  entry: ['src/index.ts', ...getTemplateEntries()],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
`;

  writeFileSync(join(targetDir, 'tsup.config.ts'), content);
}

/**
 * 生成最基础的 Feature 类
 */
function generateMinimalFeatureClass(targetDir: string, featureClass: string, featureName: string): void {
  const content = `/**
 * ${featureClass} Feature
 */

import { fileURLToPath } from 'url';
import type {
  AgentFeature,
  FeatureInitContext,
  PackageInfo,
} from '@agentdev/core';
import type { Tool } from '@agentdev/core';
import { getPackageInfoFromSource } from '@agentdev/core';

export interface ${featureClass}Config {
  /** 配置选项 */
  enabled?: boolean;
}

export class ${featureClass} implements AgentFeature {
  readonly name = '${featureName}';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\\\/g, '/');
  readonly description = '${featureClass} feature';

  private config: ${featureClass}Config;
  private _packageInfo: PackageInfo | null = null;

  constructor(config: ${featureClass}Config = {}) {
    this.config = {
      enabled: config.enabled ?? true,
    };
  }

  /**
   * 获取包信息
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表
   */
  getTemplateNames(): string[] {
    return [];
  }

  /**
   * 获取工具列表
   */
  getTools(): Tool[] {
    return [];
  }

  /**
   * 异步获取工具列表
   */
  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    return [];
  }

  /**
   * 初始化
   */
  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    // TODO: Feature 初始化逻辑
  }

  /**
   * 清理资源
   */
  async onDestroy(): Promise<void> {
    // TODO: Feature 清理逻辑
  }
}
`;

  writeFileSync(join(targetDir, 'src', 'index.ts'), content);
}

/**
 * 生成极简 README
 */
function generateMinimalReadme(targetDir: string, packageName: string, featureSlug: string): void {
  const content = `# ${packageName}

${featureSlug} feature for AgentDev.

## Installation

\`\`\`bash
npm install ${packageName}
\`\`\`

## Usage

\`\`\`typescript
import { Agent } from '@agentdev/core';
import { ${toPascalCase(featureSlug)} } from '${packageName}';

const agent = new Agent().use(new ${toPascalCase(featureSlug)}());
\`\`\`

## Development

\`\`\`bash
npm install
npm run build    # 或 npm run dev 监听模式
\`\`\`

## License

MIT
`;

  writeFileSync(join(targetDir, 'README.md'), content);
}

/**
 * 生成 copy-assets 脚本
 * 用于复制非 TypeScript 资源文件到 dist 目录
 */
function generateCopyAssetsScript(targetDir: string): void {
  const content = `#!/usr/bin/env node
/**
 * Copy non-TypeScript assets and optional feature skills to dist directory.
 * - Files under src/ are mirrored into dist/
 * - Files under skills/ are mirrored into dist/skills/
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');
const skillsDir = join(rootDir, 'skills');
const distDir = join(rootDir, 'dist');
const distSkillsDir = join(distDir, 'skills');

// Extensions to copy (non-TypeScript files)
const ASSET_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac',  // Audio
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',  // Images
  '.json',  // Config files
  '.py', '.sh', '.bash', '.zsh',  // Scripts
  '.txt', '.md', '.rst',  // Docs
  '.yml', '.yaml', '.toml', '.ini',  // Config
  '.sql', '.graphql', '.gql',  // Data
  '.html', '.css', '.scss', '.less',  // Styles
  '.wasm', '.bin',  // Binary
]);

function isAssetFile(filename) {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 && ASSET_EXTENSIONS.has(filename.slice(idx).toLowerCase());
}

function copyDirectory(src, dest) {
  if (!existsSync(src)) {
    return;
  }

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isFile() && isAssetFile(entry.name)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      console.log(\`Copied: \${relative(rootDir, srcPath)}\`);
    }
  }
}

function copySkillsDirectory(src, dest) {
  if (!existsSync(src)) {
    return;
  }

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copySkillsDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      console.log(\`Copied skill: \${relative(rootDir, srcPath)}\`);
    }
  }
}

// Copy assets from src to dist
copyDirectory(srcDir, distDir);
copySkillsDirectory(skillsDir, distSkillsDir);
`;

  writeFileSync(join(targetDir, 'scripts', 'copy-assets.mjs'), content);
}

/**
 * 工具函数
 */

function toPascalCase(str: string): string {
  return str.replace(/(?:^|-)([a-z])/g, (_, c) => c.toUpperCase());
}

function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function toKebabCase(str: string): string {
  return str.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
}

function existsSync(path: string): boolean {
  try {
    return !!fsExistsSync(path);
  } catch {
    return false;
  }
}

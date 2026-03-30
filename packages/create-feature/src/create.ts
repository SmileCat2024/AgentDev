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

interface CreateFeatureOptions {
  name: string;
  description?: string;
}

/**
 * 创建 Feature 包
 */
export async function createFeature(featureName: string): Promise<void> {
  // 规范化包名
  const packageName = featureName.startsWith('@agentdev/')
    ? featureName
    : `@agentdev/${featureName}`;

  const featureClass = toPascalCase(featureName.replace('@agentdev/', ''));
  const featureSlug = toKebabCase(featureName.replace('@agentdev/', ''));

  const targetDir = join(process.cwd(), featureSlug);

  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }

  console.log(`Creating AgentDev Feature: ${packageName}`);
  console.log(`Target directory: ${targetDir}`);

  // 创建目录结构
  mkdirSync(join(targetDir, 'src'), { recursive: true });
  mkdirSync(join(targetDir, 'src', 'templates'), { recursive: true });
  mkdirSync(join(targetDir, 'scripts'), { recursive: true });

  // 生成 package.json
  generatePackageJson(targetDir, packageName, featureSlug);

  // 生成 tsconfig.json
  generateTsConfig(targetDir);

  // 生成 tsup 配置
  generateTsupConfig(targetDir);

  // 生成 copy-assets 脚本
  generateCopyAssetsScript(targetDir);

  // 生成最基础的 Feature 类
  generateMinimalFeatureClass(targetDir, featureClass);

  // 生成 README
  generateMinimalReadme(targetDir, packageName, featureSlug);

  console.log('\n✅ Feature package created successfully!');
  console.log('\nNext steps:');
  console.log(`  cd ${featureSlug}`);
  console.log(`  npm install`);
  console.log(`  # Edit src/index.ts to implement your feature`);
  console.log(`  npm run build`);
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
      agentdev: '>=0.1.0'
    },
    devDependencies: {
      '@types/node': '^20.11.0',
      tsup: '^8.3.5',
      typescript: '^5.3.3',
      agentdev: 'latest'
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
function generateMinimalFeatureClass(targetDir: string, featureClass: string): void {
  const className = toCamelCase(featureClass);
  const content = `/**
 * ${featureClass} Feature
 */

import { fileURLToPath } from 'url';
import type {
  AgentFeature,
  FeatureInitContext,
  PackageInfo,
} from 'agentdev';
import type { Tool } from 'agentdev';
import { getPackageInfoFromSource } from 'agentdev';

export interface ${featureClass}Config {
  /** 配置选项 */
  enabled?: boolean;
}

export class ${featureClass} implements AgentFeature {
  readonly name = '${className}';
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
import { Agent } from 'agentdev';
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

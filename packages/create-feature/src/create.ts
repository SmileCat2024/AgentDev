/**
 * 创建 AgentDev Feature 包 - 最简化版本
 *
 * 只创建基础的文件夹结构和必要的文件
 * 不生成详细的示例代码
 */

import { mkdirSync, writeFileSync } from 'fs';
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

  // 生成 package.json
  generatePackageJson(targetDir, packageName, featureSlug);

  // 生成 tsconfig.json
  generateTsConfig(targetDir);

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
      build: 'tsup',
      dev: 'tsup --watch',
      prepublishOnly: 'npm run build'
    },
    tsup: {
      entry: ['src/index.ts'],
      format: 'esm',
      dts: true,
      clean: true,
      // 通用资源复制：所有非 TS 文件
      assets: [
        'src/**/*',
        '!src/**/*.ts',
        '!src/**/*.tsx'
      ]
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
    require('fs').existsSync(path);
    return true;
  } catch {
    const { existsSync: fsExistsSync } = require('fs');
    return fsExistsSync(path);
  }
}

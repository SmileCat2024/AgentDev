#!/usr/bin/env node

/**
 * 批量创建独立 Feature npm 包
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const srcFeaturesDir = join(projectRoot, 'src', 'features');
const packagesDir = join(projectRoot, 'packages');

// 需要打包的 features（不包含已创建的 shell、visual、websearch）
const featuresToPackage = [
  'audio-feedback',
  'audit',
  'memory',
  'plugin-compat',
  'qqbot',
  'tts',
];

// Feature 元信息
const featureMeta = {
  'audio-feedback': {
    name: '@agentdev/audio-feedback-feature',
    description: 'Audio feedback feature for AgentDev - plays sound notifications on call completion',
    dependencies: [],
  },
  'audit': {
    name: '@agentdev/audit-feature',
    description: 'Audit feature for AgentDev - tracks and logs tool usage',
    dependencies: ['better-sqlite3'],
  },
  'memory': {
    name: '@agentdev/memory-feature',
    description: 'Memory feature for AgentDev - provides persistent key-value storage',
    dependencies: [],
  },
  'plugin-compat': {
    name: '@agentdev/plugin-compat-feature',
    description: 'Plugin compatibility layer for AgentDev - loads OpenClaw-style plugins',
    dependencies: [],
  },
  'qqbot': {
    name: '@agentdev/qqbot-feature',
    description: 'QQ Bot feature for AgentDev - enables QQ bot integration',
    dependencies: [], // qqbot 依赖 @sliverp/qqbot/standalone，需要单独配置
  },
  'tts': {
    name: '@agentdev/tts-feature',
    description: 'Text-to-Speech feature for AgentDev - converts text to speech',
    dependencies: [],
  },
};

// 基础 package.json 模板
function createPackageJson(featureName, meta, hasTemplates) {
  const devDeps = {
    '@types/node': '^20.11.0',
    tsup: '^8.3.5',
    typescript: '^5.3.3',
    agentdev: 'file:../..'
  };

  // 为特定依赖添加类型定义
  if (meta.dependencies.includes('better-sqlite3')) {
    devDeps['@types/better-sqlite3'] = '^7.6.0';
  }

  const tsupEntry = hasTemplates
    ? ['src/index.ts', 'src/templates/*.render.ts']
    : ['src/index.ts'];

  return {
    name: meta.name,
    version: '0.1.0',
    description: meta.description,
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
      entry: tsupEntry,
      format: 'esm',
      dts: true,
      clean: true,
      sourcemap: true
    },
    peerDependencies: {
      agentdev: '>=0.1.0'
    },
    dependencies: meta.dependencies.reduce((acc, dep) => {
      acc[dep] = 'latest';
      return acc;
    }, {}),
    devDependencies: devDeps,
    keywords: ['agentdev', 'feature', featureName],
    license: 'MIT'
  };
}

// tsconfig.json 模板
const tsconfigJson = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ES2022',
    moduleResolution: 'node',
    outDir: './dist',
    rootDir: './src',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    declaration: true,
    sourceMap: true
  },
  include: ['src/**/*'],
  exclude: ['node_modules', 'dist']
};

// README.md 模板
function createReadme(featureName, meta) {
  return `# ${meta.name}

${meta.description}

## Installation

\`\`\`bash
npm install ${meta.name}
\`\`\`

## Usage

\`\`\`typescript
import { ${toPascalCase(featureName)} } from '${meta.name}';

const agent = new Agent({ ... }).use(new ${toPascalCase(featureName)}());
\`\`\`

## License

MIT
`;
}

function toPascalCase(str) {
  return str.split('-').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join('');
}

// 创建目录
function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// 复制目录
function copyDir(src, dest) {
  ensureDir(dest);
  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// 修复导入路径
function fixImports(filePath) {
  let content = readFileSync(filePath, 'utf-8');

  // 修复 import 语句
  content = content.replace(
    /from ['"]\.\.\/\.\.\/core\/([^'"]+)['"]/g,
    "from 'agentdev'"
  );
  content = content.replace(
    /from ['"]\.\.\/\.\.\/mcp\/([^'"]+)['"]/g,
    "from 'agentdev'"
  );
  content = content.replace(
    /from ['"]\.\.\/\.\.\/[^\/]+\/([^'"]+)['"]/g,
    (match, p1) => {
      // 保持内部模块的相对导入
      return match;
    }
  );

  // 修复类型导入 (import(...))
  content = content.replace(
    /import\(['"]\.\.\/\.\.\/core\/([^'"]+)['"]\)/g,
    "import('agentdev')"
  );
  content = content.replace(
    /import\(['"]\.\.\/\.\.\/mcp\/([^'"]+)['"]\)/g,
    "import('agentdev')"
  );

  writeFileSync(filePath, content);
}

// 递归修复目录中的所有 .ts 文件
function fixImportsInDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // 跳过 test 目录
    if (entry.isDirectory()) {
      if (entry.name === 'test') {
        continue;
      }
      fixImportsInDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      fixImports(fullPath);
    }
  }
}

// 主函数
async function main() {
  console.log('Creating feature packages...\n');

  for (const featureName of featuresToPackage) {
    const meta = featureMeta[featureName];
    const packageDir = join(packagesDir, `${featureName}-feature`);
    const srcDir = join(packageDir, 'src');
    const srcFeatureDir = join(srcFeaturesDir, featureName);

    console.log(`Processing: ${featureName}`);

    // 检查源目录是否存在
    if (!existsSync(srcFeatureDir)) {
      console.log(`  ⚠ Source directory not found: ${srcFeatureDir}`);
      continue;
    }

    // 创建目录结构
    ensureDir(srcDir);

    // 检测是否有模板文件
    const hasTemplates = existsSync(join(srcFeatureDir, 'templates'));

    // 写入 package.json
    const packageJson = createPackageJson(featureName, meta, hasTemplates);
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // 写入 tsconfig.json
    writeFileSync(join(packageDir, 'tsconfig.json'), JSON.stringify(tsconfigJson, null, 2));

    // 写入 README.md
    writeFileSync(join(packageDir, 'README.md'), createReadme(featureName, meta));

    // 复制源文件
    copyDir(srcFeatureDir, srcDir);

    // 修复导入路径
    fixImportsInDir(srcDir);

    console.log(`  ✓ Created ${packageDir}`);
  }

  console.log('\nDone! Now you can build and pack each feature:');
  console.log('  cd packages/<feature>-feature && npm install && npm run build && npm pack');
}

main().catch(console.error);

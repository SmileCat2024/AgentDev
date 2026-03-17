/**
 * 调试 getPackageInfoFromSource
 */

import { getPackageInfoFromSource } from './dist/core/feature.js';

console.log('=== 调试 getPackageInfoFromSource ===\n');

// 测试不同的路径格式
const testPaths = [
  'file:///D:/code/AgentDev/dist/features/shell/index.js',
  'D:/code/AgentDev/dist/features/shell/index.js',
  '/D:/code/AgentDev/dist/features/shell/index.js',
  'D:\\code\\AgentDev\\dist\\features\\shell\\index.js',
];

for (const path of testPaths) {
  console.log(`\n测试路径: ${path}`);
  const result = getPackageInfoFromSource(path);
  console.log('结果:', result);
}

// 测试实际的 Feature source
console.log('\n\n=== 测试实际 Feature source ===');
import { ShellFeature } from './dist/features/shell/index.js';

const shell = new ShellFeature();
console.log('Shell source:', (shell as any).source);

const pkgInfo = getPackageInfoFromSource((shell as any).source);
console.log('Package info:', pkgInfo);

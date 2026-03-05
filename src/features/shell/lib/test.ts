/**
 * Safe Trash 单元测试
 *
 * 测试核心功能：删除、列表、恢复
 */

import { join } from 'path';
import { cwd } from 'process';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import {
  safeRm,
  listTrashed,
  restore,
} from './index.js';
import { FileSystem, validateOperator, generateTrashName, parseTrashInfo, encodePath, decodePath } from './index.js';
import { ErrorCode, SafeRmError } from './index.js';

// 测试垃圾目录
const TEST_TRASH_DIR = join(cwd(), '.trash-test');
const TEST_FILES_DIR = join(cwd(), '.test-files');

/**
 * 清理测试环境
 */
function cleanup(): void {
  try {
    rmSync(TEST_TRASH_DIR, { recursive: true, force: true });
  } catch { }
  try {
    rmSync(TEST_FILES_DIR, { recursive: true, force: true });
  } catch { }
}

/**
 * 设置测试环境
 */
function setup(): void {
  cleanup();
  mkdirSync(TEST_FILES_DIR, { recursive: true });

  // 创建测试文件
  writeFileSync(join(TEST_FILES_DIR, 'test1.txt'), 'Test file 1');
  writeFileSync(join(TEST_FILES_DIR, 'test2.txt'), 'Test file 2');
  writeFileSync(join(TEST_FILES_DIR, 'test3.txt'), 'Test file 3');

  // 创建测试目录
  mkdirSync(join(TEST_FILES_DIR, 'dir1'), { recursive: true });
  writeFileSync(join(TEST_FILES_DIR, 'dir1', 'file1.txt'), 'File in dir1');

  // 创建嵌套目录
  mkdirSync(join(TEST_FILES_DIR, 'dir1', 'subdir'), { recursive: true });
  writeFileSync(join(TEST_FILES_DIR, 'dir1', 'subdir', 'nested.txt'), 'Nested file');
}

/**
 * 测试结果记录
 */
const results = {
  passed: 0,
  failed: 0,
  tests: [] as Array<{ name: string; passed: boolean; error?: string }>,
};

/**
 * 断言函数
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * 运行单个测试
 */
function runTest(name: string, fn: () => void): void {
  try {
    fn();
    results.passed++;
    results.tests.push({ name, passed: true });
    console.log(`✓ ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`✗ ${name}`);
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
    }
  }
}

/**
 * 测试套件 1: 路径验证
 */
function testPathValidation(): void {
  runTest('FileSystem.validatePath - 有效路径', () => {
    FileSystem.validatePath('D:\\code\\test.txt');
    FileSystem.validatePath('C:/valid/path.txt');
  });

  runTest('FileSystem.validatePath - 路径过长', () => {
    const longPath = 'A'.repeat(300);
    try {
      FileSystem.validatePath(longPath);
      assert(false, '应该抛出路径过长错误');
    } catch (error) {
      assert(error instanceof SafeRmError, '应该是 SafeRmError');
      assert((error as SafeRmError).code === ErrorCode.ERROR_PATH_TOO_LONG, '错误码应该是 ERROR_PATH_TOO_LONG');
    }
  });

  runTest('FileSystem.validatePath - 非法字符', () => {
    try {
      FileSystem.validatePath('test<file>.txt');
      assert(false, '应该抛出非法字符错误');
    } catch (error) {
      assert(error instanceof SafeRmError, '应该是 SafeRmError');
      assert((error as SafeRmError).code === ErrorCode.ERROR_INVALID_PATH, '错误码应该是 ERROR_INVALID_PATH');
    }
  });

  runTest('FileSystem.validatePath - 盘号冒号允许', () => {
    FileSystem.validatePath('D:\\test.txt');  // 应该通过
    FileSystem.validatePath('C:/test.txt');   // 应该通过
  });
}

/**
 * 测试套件 2: 操作者验证
 */
function testOperatorValidation(): void {
  runTest('validateOperator - null 操作者', () => {
    validateOperator(null);  // 应该通过
  });

  runTest('validateOperator - 有效操作者', () => {
    validateOperator('alice');
    validateOperator('bob123');
    validateOperator('user-name');
  });

  runTest('validateOperator - 非法字符', () => {
    try {
      validateOperator('user<>name');
      assert(false, '应该抛出非法字符错误');
    } catch (error) {
      assert(error instanceof SafeRmError, '应该是 SafeRmError');
      assert((error as SafeRmError).code === ErrorCode.ERROR_INVALID_OPERATOR, '错误码应该是 ERROR_INVALID_OPERATOR');
    }
  });

  runTest('validateOperator - 操作者过长', () => {
    try {
      validateOperator('a'.repeat(100));
      assert(false, '应该抛出操作者过长错误');
    } catch (error) {
      assert(error instanceof SafeRmError, '应该是 SafeRmError');
      assert((error as SafeRmError).code === ErrorCode.ERROR_INVALID_OPERATOR, '错误码应该是 ERROR_INVALID_OPERATOR');
    }
  });
}

/**
 * 测试套件 3: 文件大小计算
 */
function testFileSizeCalculation(): void {
  runTest('FileSystem.getFileSize - 文件大小', () => {
    const testFile = join(TEST_FILES_DIR, 'size_test.txt');
    writeFileSync(testFile, 'Hello World');  // 11 字节
    const size = FileSystem.getFileSize(testFile);
    assert(size === 11, `文件大小应该是 11，实际是 ${size}`);
  });

  runTest('FileSystem.getFileSize - 目录大小', () => {
    const testDir = join(TEST_FILES_DIR, 'size_dir');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'file1.txt'), 'AAAA');  // 4 字节
    writeFileSync(join(testDir, 'file2.txt'), 'BBBB');  // 4 字节

    const size = FileSystem.getFileSize(testDir);
    assert(size === 8, `目录大小应该是 8，实际是 ${size}`);
  });

  runTest('FileSystem.getsize - 不存在路径', () => {
    const size = FileSystem.getFileSize('/nonexistent/path');
    assert(size === 0, '不存在路径的大小应该是 0');
  });
}

/**
 * 测试套件 4: 删除文件
 */
function testDeleteFiles(): void {
  setup();

  runTest('safeRm - 删除单个文件', () => {
    const testFile = join(TEST_FILES_DIR, 'test1.txt');
    assert(existsSync(testFile), '测试文件应该存在');

    const result = safeRm(null, testFile, TEST_TRASH_DIR);
    assert(result.success, '删除应该成功');
    assert(result.movedCount === 1, `应该移动 1 个文件，实际 ${result.movedCount}`);
    assert(!existsSync(testFile), '原文件应该被删除');
  });

  runTest('safeRm - 删除多个文件', () => {
    const result = safeRm(null, 'test2.txt test3.txt', TEST_TRASH_DIR, null, 0);
    assert(result.success, '删除应该成功');
    assert(result.movedCount === 2, `应该移动 2 个文件，实际 ${result.movedCount}`);
  });

  runTest('safeRm - 删除目录', () => {
    const testDir = join(TEST_FILES_DIR, 'dir1');
    assert(existsSync(testDir), '测试目录应该存在');

    const result = safeRm(null, testDir, TEST_TRASH_DIR);
    assert(result.success, '删除应该成功');
    assert(result.movedCount === 1, `应该移动 1 个目录，实际 ${result.movedCount}`);
    assert(!existsSync(testDir), '原目录应该被删除');
  });

  runTest('safeRm - 强制模式删除不存在的文件', () => {
    const result = safeRm(null, '-f nonexistent.txt', TEST_TRASH_DIR);
    assert(result.success, '强制删除应该成功');
    assert(result.failedCount === 0, `应该没有失败，实际 ${result.failedCount}`);
  });
}

/**
 * 测试套件 5: 列出已删除文件
 */
function testListTrashed(): void {
  runTest('listTrashed - 列出所有文件', () => {
    const result = listTrashed(TEST_TRASH_DIR, null);
    assert(result.success, '列出应该成功');
    assert(result.total >= 4, `应该至少有 4 个文件，实际 ${result.total}`);
  });

  runTest('listTrashed - 检查文件信息', () => {
    const result = listTrashed(TEST_TRASH_DIR, null);
    assert(result.files.length > 0, '应该有文件');

    const firstFile = result.files[0];
    assert(!!firstFile.originalPath, '文件应该有原始路径');
    assert(!!firstFile.deletionDate, '文件应该有删除日期');
    assert(!!firstFile.trashFile, '文件应该有垃圾文件路径');
    assert(!!firstFile.infoFile, '文件应该有信息文件路径');
    assert(typeof firstFile.size === 'number', '文件应该有大小');
  });
}

/**
 * 测试套件 6: 恢复文件
 */
function testRestoreFiles(): void {
  runTest('restore - 按索引恢复', () => {
    const listResult = listTrashed(TEST_TRASH_DIR, null);
    assert(listResult.total > 0, '应该有文件可恢复');

    const firstIndex = listResult.files[0].index;
    const restoreResult = restore(TEST_TRASH_DIR, firstIndex, null, true);

    assert(restoreResult.success, '恢复应该成功');
    assert(restoreResult.restoredCount === 1, `应该恢复 1 个文件，实际 ${restoreResult.restoredCount}`);
  });

  runTest('restore - 按路径模式恢复', () => {
    // 先删除一个测试文件用于恢复测试
    const testFile = join(TEST_FILES_DIR, 'restore_test.txt');
    writeFileSync(testFile, 'Restore test');
    safeRm(null, testFile, TEST_TRASH_DIR);

    // 按路径模式恢复
    const restoreResult = restore(TEST_TRASH_DIR, '*restore_test.txt', null, true);
    assert(restoreResult.success, '恢复应该成功');
    assert(restoreResult.restoredCount === 1, `应该恢复 1 个文件，实际 ${restoreResult.restoredCount}`);
  });

  runTest('restore - 干运行模式', () => {
    const listResult = listTrashed(TEST_TRASH_DIR, null);
    const firstIndex = listResult.files[0].index;

    const restoreResult = restore(TEST_TRASH_DIR, firstIndex, null, false, true);
    assert(restoreResult.success, '干运行应该成功');
    assert(restoreResult.restoredCount === 1, `干运行应该报告 1 个文件`);
  });
}

/**
 * 测试套件 7: TrashInfo 解析
 */
function testTrashInfoParsing(): void {
  runTest('encodePath/decodePath - URL 编码', () => {
    const original = 'D:/code/test file with spaces.txt';
    const encoded = encodePath(original);
    const decoded = decodePath(encoded);
    assert(decoded === original, '编码解码后应该一致');
  });

  runTest('encodePath/decodePath - 特殊字符', () => {
    const original = 'D:/code/测试文件.txt';
    const encoded = encodePath(original);
    const decoded = decodePath(encoded);
    assert(decoded === original, '中文编码解码后应该一致');
  });

  runTest('generateTrashName - 生成唯一文件名', () => {
    const name1 = generateTrashName('test.txt');
    const name2 = generateTrashName('test.txt');
    assert(name1 !== name2, '两次生成的文件名应该不同');
    assert(name1.includes('test'), '文件名应该包含原始名称');
  });
}

/**
 * 测试套件 8: 边界情况
 */
function testEdgeCases(): void {
  setup();

  runTest('safeRm - 空文件列表应该失败', () => {
    try {
      safeRm(null, '', TEST_TRASH_DIR);
      assert(false, '应该抛出错误');
    } catch (error) {
      assert(error instanceof SafeRmError, '应该是 SafeRmError');
    }
  });

  runTest('safeRm - 删除系统目录应该失败', () => {
    try {
      safeRm(null, 'C:\\Windows', TEST_TRASH_DIR);
      assert(false, '应该抛出错误');
    } catch (error) {
      assert(error instanceof SafeRmError, '应该是 SafeRmError');
      assert((error as SafeRmError).code === ErrorCode.ERROR_SYSTEM_FILE, '错误码应该是 ERROR_SYSTEM_FILE');
    }
  });

  runTest('restore - 恢复不存在的索引应该失败', () => {
    const result = restore(TEST_TRASH_DIR, 9999, null);
    assert(!result.success, '恢复应该失败');
    assert(result.failedCount === 1, `应该有 1 个失败，实际 ${result.failedCount}`);
  });
}

/**
 * 测试套件 9: 完整工作流
 */
function testCompleteWorkflow(): void {
  setup();

  runTest('完整工作流 - 删除 -> 列表 -> 恢复', () => {
    // 1. 创建测试文件
    const testFile = join(TEST_FILES_DIR, 'workflow_test.txt');
    writeFileSync(testFile, 'Workflow test content');
    assert(existsSync(testFile), '测试文件应该存在');

    // 2. 删除文件
    const deleteResult = safeRm(null, testFile, TEST_TRASH_DIR);
    assert(deleteResult.success, '删除应该成功');
    assert(!existsSync(testFile), '文件应该被删除');

    // 3. 列出垃圾文件
    const listResult = listTrashed(TEST_TRASH_DIR, null);
    const found = listResult.files.find(f => f.originalPath.includes('workflow_test.txt'));
    assert(!!found, '应该能在垃圾列表中找到文件');

    // 4. 恢复文件
    const restoreResult = restore(TEST_TRASH_DIR, found!.index, null, true);
    assert(restoreResult.success, '恢复应该成功');
    assert(existsSync(testFile), '文件应该被恢复');

    // 5. 验证内容
    const content = readFileSync(testFile, 'utf-8');
    assert(content === 'Workflow test content', '文件内容应该一致');
  });
}

/**
 * 打印测试结果
 */
function printResults(): void {
  console.log('\n' + '='.repeat(60));
  console.log('测试结果汇总');
  console.log('='.repeat(60));
  console.log(`总计: ${results.passed + results.failed}`);
  console.log(`通过: ${results.passed}`);
  console.log(`失败: ${results.failed}`);

  if (results.failed > 0) {
    console.log('\n失败的测试:');
    for (const test of results.tests) {
      if (!test.passed) {
        console.log(`  - ${test.name}: ${test.error}`);
      }
    }
  }

  console.log('='.repeat(60));
}

/**
 * 主测试入口
 */
export function runTests(): void {
  console.log('Safe Trash 单元测试\n');

  try {
    testPathValidation();
    testOperatorValidation();
    testFileSizeCalculation();
    testDeleteFiles();
    testListTrashed();
    testRestoreFiles();
    testTrashInfoParsing();
    testEdgeCases();
    testCompleteWorkflow();
  } finally {
    cleanup();
  }

  printResults();

  // 返回退出码
  if (results.failed > 0) {
    process.exit(1);
  }
}

// 如果直接运行此文件，执行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}

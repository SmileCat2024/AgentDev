/**
 * 跨平台可执行文件查找
 *
 * Windows 使用 `where`，其他平台使用 `which`。
 * 返回第一个匹配的路径，找不到返回 undefined。
 */

import { execSync } from 'child_process';

export function findExecutable(command: string): string | undefined {
  if (!command) return undefined;
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? `where ${command}` : `which ${command}`;
    const result = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!result) return undefined;
    return result.split(/\r?\n/)[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

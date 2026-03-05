/**
 * Safe Trash 库统一导出
 */

// 类型定义
export * from './types.js';

// 错误处理
export * from './errors.js';

// 文件系统工具
export { FileSystem } from './fs.js';

// TrashInfo 处理
export {
  validateOperator,
  encodePath,
  decodePath,
  generateTrashName,
  createTrashInfo,
  parseTrashInfo,
  parseRmCommand,
} from './trashinfo.js';

// 删除功能
export {
  SafeRm,
  safeRm,
} from './trash.js';

// 恢复功能
export {
  SafeRestore,
  listTrashed,
  restore,
} from './restore.js';

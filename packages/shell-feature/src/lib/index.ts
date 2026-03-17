/**
 * Safe Trash 库统一导出
 */

export * from './types.js';
export * from './errors.js';
export { FileSystem } from './fs.js';
export {
  validateOperator,
  encodePath,
  decodePath,
  generateTrashName,
  createTrashInfo,
  parseTrashInfo,
  parseRmCommand,
} from './trashinfo.js';
export { SafeRm, safeRm } from './trash.js';
export { SafeRestore, listTrashed, restore } from './restore.js';

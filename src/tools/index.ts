/**
 * 工具模块统一导出
 */

// 重新导出系统工具
export {
  readFileTool,
  writeFileTool,
  listDirTool,
  shellTool,
  webFetchTool,
  calculatorTool,
  invokeSkillTool,
  SYSTEM_TOOLS,
  SYSTEM_RENDER_TEMPLATES,
  SYSTEM_TOOLS_MAP,
  getSystemTool,
  isSystemTool,
} from './system/index.js';

// 重新导出用户工具
export {
  databaseQueryTool,
  USER_TOOLS,
  USER_TOOLS_MAP,
} from './user/index.js';

// 导入
import { SYSTEM_TOOLS } from './system/index.js';
import { USER_TOOLS } from './user/index.js';

/**
 * 所有工具（系统 + 用户）
 */
export const ALL_TOOLS = [
  ...SYSTEM_TOOLS,
  ...USER_TOOLS,
] as const;

export {
  readFileTool,
  writeFileTool,
  listDirTool,
  webFetchTool,
  calculatorTool,
  getSystemTool,
  isSystemTool,
  SYSTEM_RENDER_TEMPLATES,
  SYSTEM_TOOLS_MAP,
} from './system/index.js';

export {
  databaseQueryTool,
} from './user/index.js';

// Opencode 工具已迁移到 OpencodeBasicFeature
// 如需使用，请导入 OpencodeBasicFeature：
// import { OpencodeBasicFeature } from '../features/index.js';

import { SYSTEM_TOOLS } from './system/index.js';
import { USER_TOOLS } from './user/index.js';

export const ALL_TOOLS = [
  ...SYSTEM_TOOLS,
  ...USER_TOOLS,
] as const;

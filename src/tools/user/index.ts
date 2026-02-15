/**
 * 用户工具导出
 * 展示如何组织和导出用户自定义工具
 */

import { databaseQueryTool } from './database.js';
export { databaseQueryTool };
export { renderTemplate as databaseRenderTemplate } from './database.render.js';

export const USER_TOOLS = [
  databaseQueryTool,
];

export const USER_TOOLS_MAP = {
  database_query: databaseQueryTool,
};

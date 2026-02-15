/**
 * 用户自定义工具示例：数据库查询
 * 展示如何创建用户工具和对应的渲染模板
 */

import { createTool } from '../../core/tool.js';

/**
 * 数据库查询工具
 */
export const databaseQueryTool = createTool({
  name: 'database_query',
  description: '执行数据库查询并返回结果',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'SQL 查询语句' },
      database: { type: 'string', description: '数据库名称' },
    },
    required: ['query', 'database'],
  },
  execute: async ({ query, database }) => {
    console.log(`[database_query] ${database}: ${query}`);
    // 模拟数据库查询
    return {
      database,
      query,
      rows: [
        { id: 1, name: 'Example Row 1' },
        { id: 2, name: 'Example Row 2' },
      ],
      rowCount: 2,
    };
  },
});

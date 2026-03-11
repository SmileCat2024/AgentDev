/**
 * OpencodeBasicFeature - 基础文件操作工具集
 * 来自 opencode 项目的优秀基础文件工具实现
 *
 * 包含工具：
 * - read: 文件读取（支持 offset/limit 分页）
 * - write: 文件写入（覆盖模式）
 * - edit: 文件编辑（智能匹配策略）
 * - ls: 目录列表（树形结构）
 * - glob: 文件模式搜索
 * - grep: 内容搜索（基于 ripgrep）
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AgentFeature } from '../../core/feature.js';
import { readTool, writeTool, editTool, lsTool, globTool, grepTool } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * OpencodeBasic Feature - 基础文件操作工具集
 */
export class OpencodeBasicFeature implements AgentFeature {
  readonly name = 'opencode-basic';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '提供读写文件、编辑、列目录、glob 和 grep 等基础工程化工具。';

  /**
   * 获取所有工具
   */
  getTools() {
    return [
      readTool,
      writeTool,
      editTool,
      lsTool,
      globTool,
      grepTool,
    ];
  }

  /**
   * 获取渲染模板路径映射
   */
  getTemplatePaths() {
    return {
      'read': join(__dirname, 'templates', 'read.render.js'),
      'write': join(__dirname, 'templates', 'write.render.js'),
      'edit': join(__dirname, 'templates', 'edit.render.js'),
      'ls': join(__dirname, 'templates', 'ls.render.js'),
      'glob': join(__dirname, 'templates', 'glob.render.js'),
      'grep': join(__dirname, 'templates', 'grep.render.js'),
    };
  }
}

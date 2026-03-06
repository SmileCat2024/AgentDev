/**
 * Template Router - 模板路由解析模块
 *
 * 职责：
 * - 封装模板路径解析逻辑
 * - 管理 Feature 模板和系统模板的优先级
 * - 提供浏览器可访问的 HTTP URL
 *
 * 优先级：Feature 模板 > 系统默认映射 > 兜底约定
 */

import { join } from 'path';

/**
 * 系统默认模板映射
 * 当 Feature 模板不存在时，使用此映射
 */
const SYSTEM_TEMPLATE_MAP: Record<string, string> = {
  // SubAgent 工具
  'agent-spawn': 'system/subagent',
  'agent-list': 'system/subagent',
  'agent-send': 'system/subagent',
  'agent-close': 'system/subagent',
  'wait': 'system/subagent',

  // 文件操作工具
  'file-read': 'system/fs',
  'file-write': 'system/fs',
  'file-list': 'system/fs',

  // Skill 工具
  'skill': 'system/skill',
  'invoke_skill': 'system/skill',

  // Shell 工具
  'command': 'system/shell',
  'bash': 'system/shell',
  'shell': 'system/shell',

  // Safe Trash 工具
  'trash-delete': 'system/trash',
  'trash-list': 'system/trash',
  'trash-restore': 'system/trash',
  'safe_trash_delete': 'system/trash',
  'safe_trash_list': 'system/trash',
  'safe_trash_restore': 'system/trash',

  // Web 工具
  'web': 'system/web',
  'fetch': 'system/web',

  // Math 工具
  'math': 'system/math',
  'calculator': 'system/math',

  // Todo 工具
  'task-create': 'system/todo',
  'task-list': 'system/todo',
  'task-get': 'system/todo',
  'task-update': 'system/todo',
  'task-clear': 'system/todo',

  // Opencode 工具
  'read': 'opencode/read',
  'write': 'opencode/write',
  'edit': 'opencode/edit',
  'ls': 'opencode/ls',
  'glob': 'opencode/glob',
  'grep': 'opencode/grep',
};

/**
 * Template Router 类
 */
export class TemplateRouter {
  /**
   * Feature 模板路径映射
   * 格式：{ templateName: '/absolute/path/to/template.render.js' }
   */
  private featureTemplateMap: Record<string, string> = {};

  /**
   * 更新 Feature 模板映射
   */
  updateFeatureTemplates(templates: Record<string, string>): void {
    Object.assign(this.featureTemplateMap, templates);
  }

  /**
   * 解析模板路径为浏览器可访问的 HTTP URL
   *
   * @param templateName - 模板名称（如 'trash-delete'）
   * @returns HTTP URL（如 '/features/shell/trash-delete.render.js' 或 '/tools/system/trash.render.js'）
   */
  resolveTemplateUrl(templateName: string): string {
    // 1. 优先查找 Feature 模板
    const featurePath = this.featureTemplateMap[templateName];
    if (featurePath) {
      // Feature 模板路径通常是绝对路径，需要转换为 HTTP URL
      // 例如：'/abs/path/dist/features/shell/templates/trash-delete.render.js'
      // 转换为：'/features/shell/trash-delete.render.js'
      const urlPath = this.convertFeaturePathToUrl(featurePath);
      if (urlPath) {
        return urlPath;
      }
    }

    // 2. 使用系统默认映射
    const systemPath = SYSTEM_TEMPLATE_MAP[templateName];
    if (systemPath) {
      return `/tools/${systemPath}.render.js`;
    }

    // 3. 兜底：按约定查找 opencode
    return `/tools/opencode/${templateName}.render.js`;
  }

  /**
   * 将 Feature 模板的绝对路径转换为 HTTP URL
   *
   * @param absolutePath - 绝对路径
   * @returns HTTP URL 或 null
   *
   * @example
   * // 输入：'D:/project/dist/features/shell/templates/trash-delete.render.js'
   * // 输出：'/features/shell/trash-delete.render.js'
   */
  private convertFeaturePathToUrl(absolutePath: string): string | null {
    // 匹配模式：.../dist/features/{featureName}/templates/{templateFile}.js
    // Windows 路径分隔符处理：统一转换为 /
    const normalizedPath = absolutePath.replace(/\\/g, '/');

    // 正则匹配
    const match = normalizedPath.match(/\/dist\/features\/([^/]+)\/templates\/(.+\.render\.js)$/);
    if (match) {
      const [, featureName, templateFile] = match;
      return `/features/${featureName}/${templateFile}`;
    }

    // 如果不匹配 Feature 模式，可能是其他路径，返回 null 让调用方使用系统映射
    return null;
  }

  /**
   * 解析 HTTP URL 为实际文件路径
   *
   * @param url - HTTP URL（如 '/tools/system/trash.render.js'）
   * @param projectRoot - 项目根目录
   * @returns 绝对文件路径
   */
  resolveFilePath(url: string, projectRoot?: string): string {
    if (url.startsWith('/tools/')) {
      // 系统工具模板：/tools/system/trash.render.js -> dist/tools/system/trash.render.js
      const relativePath = url.substring('/tools/'.length);
      return projectRoot
        ? join(projectRoot, 'dist/tools', relativePath)
        : join('dist/tools', relativePath);
    }

    if (url.startsWith('/features/')) {
      // Feature 工具模板：/features/shell/trash-delete.render.js -> dist/features/shell/templates/trash-delete.render.js
      const match = url.match(/^\/features\/([^/]+)\/(.+\.render\.js)$/);
      if (match) {
        const [, featureName, templateFile] = match;
        return projectRoot
          ? join(projectRoot, 'dist/features', featureName, 'templates', templateFile)
          : join('dist/features', featureName, 'templates', templateFile);
      }
    }

    // 兜底
    return url;
  }

  /**
   * 获取当前 Feature 模板映射（用于调试）
   */
  getFeatureTemplateMap(): Record<string, string> {
    return { ...this.featureTemplateMap };
  }

  /**
   * 获取系统默认映射（用于调试）
   */
  getSystemTemplateMap(): Record<string, string> {
    return { ...SYSTEM_TEMPLATE_MAP };
  }
}

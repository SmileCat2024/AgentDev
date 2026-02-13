/**
 * 渲染配置
 * 定义工具渲染模板、样式和默认映射
 */

import type { ToolRenderConfig } from './types.js';

// ============= 类型定义 =============
export interface RenderTemplate {
  /** 调用时的渲染模板 */
  call: RenderTemplateItem;
  /** 结果时的渲染模板 */
  result: RenderTemplateItem;
}

export type RenderTemplateItem =
  | string                    // 字符串模板，使用 {{key}} 插值
  | RenderTemplateFn;         // 函数模板，处理复杂逻辑

export type RenderTemplateFn = (data: Record<string, any>, success?: boolean) => string;

// ============= 模板定义 =============
/**
 * 渲染模板集合
 * 包含所有预定义的渲染模板（字符串模板和函数模板）
 */
export const RENDER_TEMPLATES: Record<string, RenderTemplate> = {
  // ----- 文件操作模板 -----
  'file': {
    call: '<div class="bash-command">Read <span class="file-path">{{path}}</span></div>',
    result: (data) => `<pre class="bash-output" style="max-height:300px;">${escapeHtml(data)}</pre>`
  },

  'file-write': {
    call: '<div class="bash-command">Write <span class="file-path">{{path}}</span></div>',
    result: (data) => `<div style="color:var(--success-color)">✓ File written successfully</div>`
  },

  'file-list': {
    call: '<div class="bash-command">List <span class="file-path">{{path}}</span></div>',
    result: (data) => {
      const files = (data || '').split('\n').filter((f: string) => f);
      return `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:4px; font-family:monospace; font-size:12px;">
        ${files.map((f: string) => `<div style="color:var(--text-primary);">${escapeHtml(f)}</div>`).join('')}
      </div>`;
    }
  },

  // ----- 命令执行模板 -----
  'command': {
    call: '<div class="bash-command">> {{command}}</div>',
    result: (data) => `<pre class="bash-output">${escapeHtml(data)}</pre>`
  },

  // ----- 网络请求模板 -----
  'web': {
    call: '<div>GET <a href="{{url}}" target="_blank" style="color:var(--accent-color)">{{url}}</a></div>',
    result: (data) => `<div style="font-size:12px; opacity:0.8;">Fetched ${String(data).length} chars</div>`
  },

  // ----- 数学计算模板 -----
  'math': {
    call: '<div class="bash-command">{{expression}}</div>',
    result: (data) => `<div class="bash-command" style="color:#d2a8ff">= ${escapeHtml(data)}</div>`
  },

  // ----- 内置类型 -----
  'json': {
    call: (args) => `<pre style="margin:0; font-size:12px;">${escapeHtml(JSON.stringify(args, null, 2))}</pre>`,
    result: (data) => {
      const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
      return `<pre class="bash-output">${escapeHtml(displayData)}</pre>`;
    }
  },

  // ----- Skills 工具 -----
  'skill': {
    call: '<div class="bash-command">Skill <span class="file-path">{{skill}}</span></div>',
    result: (data) => `<pre class="bash-output" style="max-height:400px;">${escapeHtml(data)}</pre>`
  },
} as const;

// ============= 默认映射 =============
/**
 * 系统工具的默认渲染模板映射
 * 工具名称 -> 模板名称
 */
export const SYSTEM_RENDER_MAP: Record<string, string> = {
  // 文件系统工具
  'read_file': 'file',
  'write_file': 'file-write',
  'list_directory': 'file-list',

  // Shell 工具
  'run_shell_command': 'command',

  // Web 工具
  'web_fetch': 'web',

  // Math 工具
  'calculator': 'math',

  // Skills 工具
  'invoke_skill': 'skill',
} as const;

// ============= 工具显示名称映射 =============
/**
 * 工具显示名称（用于UI展示）
 */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  'run_shell_command': 'Bash',
  'read_file': 'Read File',
  'write_file': 'Write File',
  'list_directory': 'LS',
  'web_fetch': 'Web',
  'calculator': 'Calc',
} as const;

// ============= 辅助函数 =============
/**
 * HTML 转义
 */
function escapeHtml(text: any): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

// ============= 模板引擎 =============
/**
 * 简单的字符串模板插值
 * 支持 {{key}} 语法
 */
export function interpolateTemplate(template: string, data: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key];
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}

/**
 * 应用渲染模板
 */
export function applyTemplate(
  template: RenderTemplateItem,
  data: Record<string, any>,
  success = true
): string {
  if (typeof template === 'function') {
    return template(data, success);
  }
  return interpolateTemplate(template, data);
}

// ============= 导出合并函数 =============
/**
 * 获取工具的渲染配置（合并默认值）
 */
export function getToolRenderConfig(
  toolName: string,
  customRender?: ToolRenderConfig
): ToolRenderConfig {
  // 优先级：自定义配置 > 系统默认映射 > 'json'
  const systemDefault = SYSTEM_RENDER_MAP[toolName];
  const defaultTemplate = systemDefault || 'json';

  return {
    call: customRender?.call || defaultTemplate,
    result: customRender?.result || defaultTemplate,
  };
}

/**
 * 获取工具的渲染模板
 */
export function getToolRenderTemplate(toolName: string, customRender?: ToolRenderConfig): RenderTemplate {
  const config = getToolRenderConfig(toolName, customRender);
  const callTemplateName = config.call || 'json';
  const resultTemplateName = config.result || 'json';
  const callTemplate = RENDER_TEMPLATES[callTemplateName] || RENDER_TEMPLATES['json'];
  const resultTemplate = RENDER_TEMPLATES[resultTemplateName] || RENDER_TEMPLATES['json'];

  return {
    call: callTemplate.call,
    result: resultTemplate.result,
  };
}

/**
 * 获取工具显示名称
 */
export function getToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] || toolName;
}

/**
 * 渲染配置
 * 定义工具渲染模板、样式和默认映射
 */

import type { ToolRenderConfig, RenderTemplateItem, RenderTemplateFn } from './types.js';

// ============= 类型定义 =============
export interface RenderTemplate {
  /** 调用时的渲染模板 */
  call: RenderTemplateItem;
  /** 结果时的渲染模板 */
  result: RenderTemplateItem;
}

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

  // ----- Agent Spawn -----
  'agent-spawn': {
    call: '<div class="bash-command">Spawn <span class="file-path">{{type}}</span> agent: {{instruction}}</div>',
    result: (data) => {
      if (data.error) {
        return `<div style="color:var(--error-color)">✗ ${data.error}</div>`;
      }
      return `<div style="color:var(--success-color)">✓ Agent: <strong>${data.agentId}</strong> (${data.type})</div>`;
    }
  },

  // ----- Agent List -----
  'agent-list': {
    call: '<div class="bash-command">List agents (filter: {{filter}})</div>',
    result: (data) => {
      if (!data.agents || data.agents.length === 0) {
        return `<div style="color:var(--warning-color)">No agents found</div>`;
      }
      return `<div style="font-size:12px;">
        <div>Total: ${data.total} | Running: ${data.running}</div>
        ${data.agents.map((a: any) => `
          <div style="margin-top:4px; padding:4px; background:var(--code-bg); border-radius:4px;">
            <strong>${a.agentId}</strong> (${a.type}) - <span style="color:${a.status === 'running' ? 'var(--success-color)' : 'var(--warning-color)'}">${a.status}</span>
          </div>
        `).join('')}
      </div>`;
    }
  },

  // ----- Agent Send -----
  'agent-send': {
    call: '<div class="bash-command">Send to <span class="file-path">{{agentId}}</span>: {{message}}</div>',
    result: (data) => {
      if (data.error) {
        return `<div style="color:var(--error-color)">✗ ${data.error}</div>`;
      }
      return `<div style="color:var(--success-color)">✓ Message sent to ${data.agentId}</div>`;
    }
  },

  // ----- Agent Close -----
  'agent-close': {
    call: '<div class="bash-command">Close <span class="file-path">{{agentId}}</span> (reason: {{reason}})</div>',
    result: (data) => {
      if (data.error) {
        return `<div style="color:var(--error-color)">✗ ${data.error}</div>`;
      }
      return `<div style="color:var(--success-color)">✓ ${data.message}</div>`;
    }
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

  // Agent 工具
  'spawn_agent': 'agent-spawn',
  'list_agents': 'agent-list',
  'send_to_agent': 'agent-send',
  'close_agent': 'agent-close',
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
  'invoke_skill': 'Invoke Skill',
  'spawn_agent': 'Spawn Agent',
  'list_agents': 'List Agents',
  'send_to_agent': 'Send to Agent',
  'close_agent': 'Close Agent',
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

// ============= 动态模板加载 =============
/**
 * 从文件加载渲染模板
 * @param toolPath 工具路径（相对于项目根目录）
 */
export async function loadRenderTemplate(
  toolPath: string
): Promise<RenderTemplate | undefined> {
  try {
    // 构建模板文件路径：工具目录 + .render.ts
    const templatePath = toolPath + '.render.ts';

    // 动态导入模板模块
    const module = await import(templatePath);

    // 模块应导出 default 或 render 函数返回 RenderTemplate
    if (module.default && typeof module.default === 'object') {
      return module.default as RenderTemplate;
    }
    if (module.render && typeof module.render === 'function') {
      return await module.render();
    }

    return undefined;
  } catch {
    // 文件不存在或导入失败，返回 undefined
    return undefined;
  }
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

  // 处理 call 模板
  let callTemplate: RenderTemplateItem;
  if (typeof config.call === 'object' && config.call !== null) {
    // 内联模板
    callTemplate = config.call.call;
  } else {
    // 字符串引用
    const callTemplateName = config.call || 'json';
    callTemplate = RENDER_TEMPLATES[callTemplateName]?.call || RENDER_TEMPLATES['json'].call;
  }

  // 处理 result 模板
  let resultTemplate: RenderTemplateItem;
  if (typeof config.result === 'object' && config.result !== null) {
    // 内联模板
    resultTemplate = config.result.result;
  } else {
    // 字符串引用
    const resultTemplateName = config.result || 'json';
    resultTemplate = RENDER_TEMPLATES[resultTemplateName]?.result || RENDER_TEMPLATES['json'].result;
  }

  return {
    call: callTemplate,
    result: resultTemplate,
  };
}

/**
 * 获取工具显示名称
 */
export function getToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] || toolName;
}

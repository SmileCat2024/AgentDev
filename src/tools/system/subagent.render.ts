/**
 * 子代理工具渲染模板
 * 使用 viewer-worker.ts HTML 中的版本（带 agent 列表显示）
 */

import type { RenderTemplate } from '../../core/render.js';

/**
 * HTML 转义辅助函数
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

export const spawnAgentRender: RenderTemplate = {
  call: (args) => {
    return `<div class="bash-command">启动 <span class="pattern">${escapeHtml(args.type || '')}</span> 子代理</div>`;
  },
  result: (data) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${escapeHtml(data.error)}</div>`;
    }
    let output = `<div class="bash-command">已创建 <span class="pattern">${escapeHtml(data.agentId || '')}</span></div>`;
    output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px;">类型: ${escapeHtml(data.type || '')} · 状态: ${escapeHtml(data.status || '')}</div>`;

    // 显示所有 agent 列表
    if (data.allAgents && data.allAgents.length > 0) {
      const agentsList = data.allAgents.map((a: any) => {
        const statusText = a.status === 'busy' ? '[运行中]' : a.status === 'idle' ? '[空闲]' : '[已完成]';
        return `${statusText} ${escapeHtml(a.agentId)}`;
      }).join(' · ');
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; margin-top:4px;">${agentsList}</div>`;
    }
    return output;
  }
};

export const listAgentsRender: RenderTemplate = {
  call: '<div class="bash-command">List agents (filter: {{filter}})</div>',
  result: (data) => {
    if (!data.agents || data.agents.length === 0) {
      return `<div style="color:var(--warning-color)">No agents found</div>`;
    }
    return `<div style="font-size:12px;">
      <div>Total: ${data.total} | Running: ${data.running}</div>
      ${data.agents.map((a: any) => `
        <div style="margin-top:4px; padding:4px; background:var(--code-bg); border-radius:4px;">
          <strong>${a.agentId}</strong> (${a.type}) - <span style="color:${a.status === 'idle' || a.status === 'busy' ? 'var(--success-color)' : 'var(--warning-color)'}">${a.status}</span>
        </div>
      `).join('')}
    </div>`;
  }
};

export const sendToAgentRender: RenderTemplate = {
  call: (args) => {
    return `<div class="bash-command">发送指令到 <span class="pattern">${escapeHtml(args.agentId || '')}</span></div>`;
  },
  result: (data) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${escapeHtml(data.error)}</div>`;
    }
    let output = `<div style="color:var(--success-color)">✓ 指令已发送</div>`;

    // 显示所有 agent 列表
    if (data.allAgents && data.allAgents.length > 0) {
      const agentsList = data.allAgents.map((a: any) => {
        const statusText = a.status === 'busy' ? '[运行中]' : a.status === 'idle' ? '[空闲]' : '[已完成]';
        return `${statusText} ${escapeHtml(a.agentId)}`;
      }).join(' · ');
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; margin-top:4px;">${agentsList}</div>`;
    }
    return output;
  }
};

export const closeAgentRender: RenderTemplate = {
  call: (args) => {
    return `<div class="bash-command">Close <span class="pattern">${escapeHtml(args.agentId || '')}</span> (reason: ${args.reason || 'manual'})</div>`;
  },
  result: (data) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${escapeHtml(data.error)}</div>`;
    }
    return `<div style="color:var(--success-color)">✓ ${data.message || 'Agent closed'}</div>`;
  }
};

export const waitRender: RenderTemplate = {
  call: () => {
    return `<div class="bash-command">等待子代理运行完成......</div>`;
  },
  result: (data) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${escapeHtml(data.error)}</div>`;
    }
    return `<div style="color:var(--info-color)">${escapeHtml(data.message || '等待子代理运行结果...')}</div>`;
  }
};

/**
 * 模板映射表
 * 模板名格式：分类-功能名（如 'agent-spawn'）
 * 文件名：根据模板名第一段确定（'agent-spawn' → agent.render.ts）
 */
export const TEMPLATES = {
  'agent-spawn': spawnAgentRender,
  'agent-list': listAgentsRender,
  'agent-send': sendToAgentRender,
  'agent-close': closeAgentRender,
  'wait': waitRender,
};

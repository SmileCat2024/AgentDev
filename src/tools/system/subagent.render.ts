/**
 * 子代理工具渲染模板
 */

import type { RenderTemplate } from '../../core/render.js';

export const spawnAgentRender: RenderTemplate = {
  call: '<div class="bash-command">启动 <span class="file-path">{{type}}</span> 子代理: {{instruction}}</div>',
  result: (data) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${data.error}</div>`;
    }
    return `<div style="color:var(--success-color)">
      ✓ 子代理已创建: <strong>${data.agentId}</strong> (${data.type}) - ${data.status}
    </div>`;
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
  call: '<div class="bash-command">发送指令到 <span class="file-path">{{agentId}}</span>: {{message}}</div>',
  result: (data) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${data.error}</div>`;
    }
    return `<div style="color:var(--success-color)">✓ 指令已发送到 ${data.agentId}</div>`;
  }
};

export const closeAgentRender: RenderTemplate = {
  call: '<div class="bash-command">Close <span class="file-path">{{agentId}}</span> (reason: {{reason}})</div>',
  result: (data) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${data.error}</div>`;
    }
    return `<div style="color:var(--success-color)">✓ ${data.message}</div>`;
  }
};

export const waitRender: RenderTemplate = {
  call: '<div class="bash-command">⏳ Waiting for sub-agents...</div>',
  result: (data) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${data.error}</div>`;
    }
    return `<div style="color:var(--info-color)"> ${data.message || '等待子代理运行结果...'}</div>`;
  }
};

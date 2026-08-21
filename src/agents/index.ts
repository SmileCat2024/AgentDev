/**
 * Agents 模块导出
 *
 * 预置 Agent 均为纯基类（零内置 Feature 装配，装配权在宿主）。
 */

export { BasicAgent } from './system/BasicAgent.js';
export type { BasicAgentConfig, SystemContext } from './system/BasicAgent.js';

export { ExplorerAgent } from './system/ExplorerAgent.js';
export type { ExplorerAgentConfig, SystemContext as ExplorerSystemContext } from './system/ExplorerAgent.js';

import { getClawRuntimeUrl, resolveDebugTransportMode } from '../src/core/debug-transport.js';

export { resolveDebugTransportMode };

export function getDebugUiUrl(port: number = 2026): string {
  if (resolveDebugTransportMode() === 'claw') {
    return getClawRuntimeUrl();
  }
  return `http://localhost:${port}`;
}

export async function checkDebugTransportRunning(port: number = 2026): Promise<boolean> {
  const transport = resolveDebugTransportMode();
  const url = transport === 'claw'
    ? `${getClawRuntimeUrl()}/health`
    : `http://localhost:${port}/api/agents`;

  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

export function printDebugTransportHelp(port: number = 2026): void {
  const transport = resolveDebugTransportMode();
  if (transport === 'claw') {
    console.error('错误: Claw runtime 未运行');
    console.error('请先启动 AgentDevClaw runtime');
    console.error('');
    console.error('例如在新终端运行:');
    console.error('  cd D:\\code\\AgentDevClaw');
    console.error('  npm run dev:runtime');
    console.error('');
    return;
  }

  console.error('错误: ViewerWorker 服务器未运行');
  console.error('请先启动服务器: npm run server');
  console.error('');
  console.error('或者在新终端运行:');
  console.error('  npm run server');
  console.error('');
}

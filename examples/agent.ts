/**
 * 基础 Agent 示例
 * 适配新版本生命周期 API
 */

import { Agent, createOpenAILLM, loadConfig, fsTools, shellTools, webTools, mathTools } from '../src/index.js';
import { execSync } from 'child_process';
import { createServer } from 'http';

// ==================== 辅助函数 ====================

/**
 * 检测端口是否可用
 */
function isPortAvailable(port: number): boolean {
  try {
    execSync(`netstat -ano | findstr :${port}`, { stdio: 'pipe', encoding: 'utf-8', windowsHide: true });
    return false;  // 端口被占用
  } catch {
    return true;  // 端口可用
  }
}

/**
 * 查找可用端口
 */
function findAvailablePort(startPort: number): number {
  for (let port = startPort; port < startPort + 10; port++) {
    if (isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`无法找到可用端口 (从 ${startPort} 开始)`);
}

// ==================== 主程序 ====================

async function main() {
  const config = await loadConfig();
  const llm = createOpenAILLM(config.model.apiKey, config.model.name, config.model.baseUrl);

  const agent = new Agent({
    llm,
    tools: [
      fsTools.readFileTool,
      fsTools.writeFileTool,
      fsTools.listDirTool,
      shellTools.shellTool,
      webTools.webFetchTool,
      mathTools.calculatorTool,
    ],
    maxTurns: Infinity,  // 无限循环，由用户主动退出
    // 移除 systemMessage - 没有初始指令
  });

  // 查找可用端口并启动调试服务器
  const debugPort = findAvailablePort(2026);
  await agent.withViewer(debugPort);
  console.log(`调试页面: http://localhost:${debugPort}\n`);

  console.log('--- Agent 已启动 (无限循环模式) ---\n');
  console.log('可用工具: read_file, write_file, list_directory, run_shell_command, web_fetch, calculator');
  console.log('输入 Ctrl+C 或输入 "exit" 退出\n');

  // 无限循环：持续等待用户输入
  while (true) {
    try {
      // 调用 agenthook 命令获取用户输入（阻塞等待）
      const input = execSync('npx agenthook', {
        encoding: 'utf-8',
        stdio: ['inherit', 'pipe', 'inherit']
      }).trim();

      // 检查退出命令
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log('\n再见！');
        break;
      }

      // 空输入跳过
      if (!input) {
        continue;
      }

      console.log(`\n> ${input}`);
      console.log('---');

      // 使用新的 API：onCall() 替代 run()
      const result = await agent.onCall(input);

      console.log(`\n结果: ${result}\n`);

    } catch (error) {
      // 忽略 Ctrl+C 的中断错误
      if ((error as any).code === 130) {
        console.log('\n再见！');
        break;
      }
      console.error('执行出错:', error);
    }
  }
}

main().catch(console.error);

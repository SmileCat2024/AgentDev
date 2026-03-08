/**
 * VisualFeature 工具定义
 */

import { spawn } from 'child_process';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import type {
  CaptureResult,
  VisualUnderstandingResult,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ========== LLM 配置 ==========

const DEFAULT_BASE_URL = 'http://localhost:7575';
const DEFAULT_MODEL = 'Qwen3.5-4B-Q5_K_M';

// 视觉理解系统提示词（侧重内容理解）
const VISION_SYSTEM_PROMPT = `# Role
你是一位专业的视觉内容分析专家。你的任务是仔细观察用户提供的截图，并给出准确、详细的内容描述。

# Task
分析截图中的视觉内容，重点描述：
1. **主要内容**：截图显示的是什么应用、什么界面
2. **文本内容**：所有可见的文字、标签、提示信息
3. **关键元素**：重要的按钮、输入框、菜单项等可交互元素
4. **状态信息**：当前界面状态（如：选中/未选中、展开/收起等）
5. **异常或特殊点**：错误提示、警告信息、弹窗等

# Output Requirements
- 使用自然语言描述，不要使用 JSON 或其他结构化格式
- 描述要准确、清晰，便于后续处理
- 如果图片不清晰或无法理解，直接说明
- 输出语言与截图中的主要语言保持一致

# Example Output
这是一个代码编辑器窗口，显示的是一个 TypeScript 文件。左侧是文件树，当前选中了 "src/features/visual/tools.ts"。右侧是代码编辑区，显示的是工具定义代码，包含 "capture_and_understand_window" 函数。底部有一个终端面板，显示了 npm run build 的输出结果。`;

// ========== 工具实现 ==========

/**
 * 调用 Python 脚本截图指定窗口
 */
async function captureWindow(
  hwnd: string,
  pythonPath: string = 'python',
  pythonArgs?: string[]
): Promise<CaptureResult> {
  const scriptPath = join(__dirname, 'python', 'capture.py');

  return new Promise((resolve) => {
    // 支持 pythonArgs 配置（如 uv run）
    const args = pythonArgs
      ? [...pythonArgs, scriptPath, hwnd]
      : [scriptPath, hwnd];

    // 继承父进程的环境变量（包括 PATH），这样能找到 uv 管理的 Python
    const child = spawn(pythonPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }, // 继承环境变量
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ error: `Python script failed (exit code ${code}): ${stderr}` });
        return;
      }

      try {
        const result: CaptureResult = JSON.parse(stdout.trim());
        resolve(result);
      } catch (error) {
        resolve({ error: `Failed to parse Python output: ${error}` });
      }
    });

    child.on('error', (error) => {
      resolve({ error: `Failed to spawn Python: ${error.message}` });
    });
  });
}

/**
 * 调用 LLM 进行视觉理解
 */
async function understandImage(
  base64Image: string,
  client: OpenAI,
  model: string
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: VISION_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请分析这张截图的内容。',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content ?? '无法理解图片内容';
}

/**
 * 创建 capture_and_understand_window 工具
 */
export function createCaptureAndUnderstandTool(
  client: OpenAI,
  model: string,
  pythonPath: string = 'python',
  pythonArgs?: string[]
): Tool {
  return createTool({
    name: 'capture_and_understand_window',
    description: '截取指定窗口的截图并使用视觉模型理解其内容。输入参数为窗口句柄（HWND），如 "0x12345" 或 "12345"。返回截图内容的详细描述。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: {
          type: 'string',
          description: '窗口句柄，支持 16 进制格式（如 "0x12345"）或 10 进制格式（如 "12345"）',
        },
      },
      required: ['hwnd'],
    },
    render: { call: 'capture', result: 'capture' },
    execute: async ({ hwnd }: { hwnd: string }) => {
      // 1. 截图
      const captureResult = await captureWindow(hwnd, pythonPath, pythonArgs);

      if (captureResult.error || !captureResult.data) {
        return `截图失败：${captureResult.error ?? '未知错误'}`;
      }

      // 2. 视觉理解
      try {
        const description = await understandImage(captureResult.data, client, model);
        return `截图成功（${captureResult.width}x${captureResult.height}）\n\n内容分析：\n${description}`;
      } catch (error) {
        return `截图成功（${captureResult.width}x${captureResult.height}），但视觉理解失败：${error}`;
      }
    },
  });
}

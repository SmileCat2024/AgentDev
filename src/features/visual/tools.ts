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

// 视觉理解系统提示词（增量分析版本）
const VISION_SYSTEM_PROMPT = `# Role
你是一位专业的视觉内容分析专家。你的任务是仔细观察用户提供的截图，并给出准确、详细的内容描述。

# Task
分析截图中的视觉内容，重点描述：
1. **主要内容**：截图显示的是什么应用、什么界面
2. **文本内容**：所有可见的文字、标签、提示信息
3. **关键元素**：重要的按钮、输入框、菜单项等可交互元素
4. **状态信息**：当前界面状态（如：选中/未选中、展开/收起等）
5. **异常或特殊点**：错误提示、警告信息、弹窗等

# 增量分析策略
你会收到窗口上下文信息（进程名、窗口标题）和上次的识别结果。请根据这些信息进行增量分析：

## 情况 1：完全不同的页面
如果新截图显示的页面与上次识别结果完全不同（例如：从代码编辑器切换到浏览器），请直接描述新页面的完整内容。

## 情况 2：相同页面，视角变化
如果新截图与上次是同一个页面，但视角发生了变化（例如：滚动到了新位置、展开了新的菜单、切换了标签页），请只描述**新看到的内容**，不需要重复描述之前已经识别过的内容。

## 情况 3：相同页面，更正之前的内容
如果新截图与上次是同一个页面，但你发现之前的识别有错误或遗漏，请直接更正或补充。例如：
- "更正：之前识别为'确认'的按钮实际是'取消'"
- "补充：页面上方还有一个搜索栏，输入框显示'请输入关键词'"

# Output Requirements
- 使用自然语言描述，不要使用 JSON 或其他结构化格式
- 描述要准确、清晰，便于后续处理
- 如果图片不清晰或无法理解，直接说明
- 输出语言与截图中的主要语言保持一致

# Example Output (完全不同的页面)
这是一个浏览器窗口，显示的是一个购物网站。顶部有导航栏，显示"首页、分类、购物车、我的"。中间部分是商品列表，每个商品卡片包含图片、名称、价格和"加入购物车"按钮。当前显示的是"电子产品"分类。

# Example Output (相同页面，视角变化)
页面向下滚动后，显示了更多的商品。新看到的商品包括：一款无线鼠标（价格：199元）、一个机械键盘（价格：399元）和一个显示器（价格：1299元）。每个商品都有"加入购物车"按钮。

# Example Output (更正之前的内容)
更正：之前将页面顶部的文字识别为"登录"，实际应该是"注册"。页面顶部右侧有"注册"和"登录"两个按钮，当前"注册"按钮处于高亮状态。`;

// ========== 工具实现 ==========

/**
 * 调用 Python 脚本截图指定窗口
 */
export async function captureWindow(
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
 * @param base64Image base64 编码的图片
 * @param client OpenAI 客户端
 * @param model 模型名称
 * @param windowInfo 窗口信息（进程名、标题等）
 * @param previousAnalysis 上次的分析结果（可选）
 */
async function understandImage(
  base64Image: string,
  client: OpenAI,
  model: string,
  windowInfo?: {
    processName?: string;
    windowTitle?: string;
  },
  previousAnalysis?: string
): Promise<string> {
  // 构建用户消息，包含窗口上下文和上次分析结果
  let userText = '请分析这张截图的内容。';

  if (windowInfo?.processName || windowInfo?.windowTitle) {
    userText += '\n\n# 窗口信息';
    if (windowInfo.processName) {
      userText += `\n- 进程名称：${windowInfo.processName}`;
    }
    if (windowInfo.windowTitle) {
      userText += `\n- 窗口标题：${windowInfo.windowTitle}`;
    }
  }

  if (previousAnalysis) {
    userText += `\n\n# 上次识别结果\n${previousAnalysis}`;
    userText += '\n\n请根据上次识别结果进行增量分析。如果页面完全不同，请直接描述新页面的完整内容；如果是相同页面但视角变化，请只描述新看到的内容；如果需要更正之前的内容，请直接说明。';
  }

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
            text: userText,
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

// 导出 understandImage 函数供其他模块使用
export { understandImage };

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

/**
 * VisualFeature 工具定义
 *
 * 提供两个视觉理解工具：
 * 1. capture_and_understand_window - 使用 4B 模型（快速）
 * 2. capture_and_understand_window_advanced - 使用 9B 模型（准确）
 *
 * 两个工具都支持缓存回退：
 * - 截图失败时（窗口缩小）使用缓存的图片
 * - 检测到纯色图时使用缓存的图片
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import type {
  CaptureResult,
  VisualUnderstandingResult,
} from './types.js';
import type { VisualCacheManager } from './cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ========== LLM 配置 ==========

const DEFAULT_BASE_URL = 'http://localhost:7575';
const DEFAULT_MODEL = 'Qwen3.5-4B-Q5_K_M';

const DEFAULT_ADVANCED_BASE_URL = 'http://localhost:7577';
const DEFAULT_ADVANCED_MODEL = 'Qwen3.5-9B-Q4_K_M';

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

// ========== 辅助函数 ==========

/**
 * 检测是否为纯色图
 * 通过采样图片的几个关键点来判断是否为纯色
 */
function isSolidColorImage(base64Image: string): boolean {
  try {
    // 解码 base64 获取 PNG 数据
    const imageBuffer = Buffer.from(base64Image, 'base64');

    // 简单检测：检查图片大小，如果太小（小于 1KB）可能是纯色或错误
    if (imageBuffer.length < 1024) {
      return true;
    }

    // PNG 文件头的 IHDR chunk 之后是 IDAT（图像数据）
    // 我们可以检查图片是否包含足够的颜色变化
    // 这里做一个简单的启发式检查：如果压缩后非常小，可能是纯色

    // 更精确的方法是解码 PNG，但这需要额外的库
    // 作为替代，我们检查文件大小与像素数的比例
    // 对于普通截图，这个比例通常在 0.1 - 1 字节/像素之间
    // 纯色图压缩后通常 < 0.01 字节/像素

    // 从 PNG IHDR chunk 读取宽高（简化版）
    // IHDR 位于 PNG 签名后 8 字节，宽度 4 字节，高度 4 字节
    if (imageBuffer.length > 24) {
      const width = imageBuffer.readUInt32BE(16);
      const height = imageBuffer.readUInt32BE(20);
      const pixelCount = width * height;
      const bytesPerPixel = imageBuffer.length / pixelCount;

      // 如果每个像素平均 < 0.02 字节，很可能是纯色
      if (bytesPerPixel < 0.02) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.warn('[VisualFeature] Error checking for solid color image:', error);
    return false;
  }
}

/**
 * 从缓存读取最新的图片
 */
function getCachedImageBase64(cacheManager: VisualCacheManager, hwnd: string): string | null {
  try {
    const capturePath = cacheManager.getCapturePath(hwnd);
    if (!capturePath) {
      return null;
    }

    // 读取图片文件并转换为 base64
    const imageBuffer = readFileSync(capturePath);
    return imageBuffer.toString('base64');
  } catch (error) {
    console.warn(`[VisualFeature] Failed to read cached image for ${hwnd}:`, error);
    return null;
  }
}

/**
 * 从缓存获取上次的窗口信息（用于标题、进程名等）
 */
function getCachedWindowInfo(cacheManager: VisualCacheManager, hwnd: string): {
  title: string;
  processName?: string;
} | null {
  try {
    const entries = cacheManager.getAllEntries();
    const entry = entries.find(e => e.hwnd === hwnd);
    if (entry) {
      return {
        title: entry.title,
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * 检查缓存图片是否已有该模型的分析结果
 * 返回分析结果（如果存在且模型匹配）或 null
 */
function getCachedAnalysisForModel(
  cacheManager: VisualCacheManager,
  hwnd: string,
  model: string
): { description: string; createdAt: number } | null {
  try {
    const entry = cacheManager['metadata']?.entries?.[hwnd];
    if (!entry?.analysis?.description) {
      return null;
    }

    // 检查模型是否匹配
    if (entry.analysis.model !== model) {
      console.log(`[VisualFeature] Cached analysis model mismatch: cached=${entry.analysis.model}, requested=${model}`);
      return null;
    }

    // 检查分析结果是否过期（使用较长的 TTL，因为缓存图片的分析结果可以复用）
    const now = Date.now();
    const age = now - entry.analysis.createdAt;
    const cacheReuseTTL = 24 * 60 * 60 * 1000; // 24小时 - 缓存图片的分析结果可以复用更久

    if (age > cacheReuseTTL) {
      console.log(`[VisualFeature] Cached analysis too old: ${Math.round(age / 1000)}s`);
      return null;
    }

    console.log(`[VisualFeature] Reusing cached analysis for ${hwnd} (model: ${model})`);
    return {
      description: entry.analysis.description,
      createdAt: entry.analysis.createdAt,
    };
  } catch (error) {
    return null;
  }
}

// ========== 核心功能函数 ==========

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
export async function understandImage(
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

// ========== 工具工厂函数 ==========

/**
 * 创建基础视觉理解工具（4B 模型）
 * 支持缓存回退：截图失败或纯色图时使用缓存图片
 */
export function createCaptureAndUnderstandTool(
  client: OpenAI,
  model: string,
  pythonPath: string = 'python',
  pythonArgs?: string[],
  cacheManager?: VisualCacheManager | null
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
      // 1. 尝试截图
      let captureResult = await captureWindow(hwnd, pythonPath, pythonArgs);

      let imageToAnalyze = captureResult.data;
      let imageSource = '新截图';
      let analysisNote = '';
      let usedCachedImage = false;

      // 2. 如果截图失败，尝试使用缓存
      if (captureResult.error || !captureResult.data) {
        if (cacheManager) {
          console.log(`[capture_and_understand_window] Screenshot failed for ${hwnd}, trying cache...`);
          const cachedImage = getCachedImageBase64(cacheManager, hwnd);
          if (cachedImage) {
            imageToAnalyze = cachedImage;
            imageSource = '缓存图片';
            usedCachedImage = true;
            analysisNote = `[使用缓存图片，因为截图失败：${captureResult.error}]`;
            console.log(`[capture_and_understand_window] Using cached image for ${hwnd}`);
          } else {
            return `截图失败且无缓存可用：${captureResult.error ?? '未知错误'}`;
          }
        } else {
          return `截图失败：${captureResult.error ?? '未知错误'}`;
        }
      }

      // 3. 检查是否为纯色图，如果是则使用缓存
      if (imageToAnalyze && isSolidColorImage(imageToAnalyze)) {
        console.log(`[capture_and_understand_window] Detected solid color image for ${hwnd}, trying cache...`);
        if (cacheManager) {
          const cachedImage = getCachedImageBase64(cacheManager, hwnd);
          if (cachedImage) {
            imageToAnalyze = cachedImage;
            imageSource = '缓存图片';
            usedCachedImage = true;
            analysisNote = '[使用缓存图片，因为新截图是纯色图（窗口可能被最小化或遮挡）]';
            console.log(`[capture_and_understand_window] Using cached image for ${hwnd} (solid color detected)`);
          }
        }
      }

      // 4. 如果没有可用的图片
      if (!imageToAnalyze) {
        return '无法获取可用的图片进行分析';
      }

      // 5. 缓存去重：如果使用了缓存图片，检查是否已有该模型的分析结果
      if (usedCachedImage && cacheManager) {
        const cachedAnalysis = getCachedAnalysisForModel(cacheManager, hwnd, model);
        if (cachedAnalysis) {
          // 直接返回缓存的分析结果，不需要重新调用模型
          const age = Math.round((Date.now() - cachedAnalysis.createdAt) / 1000);
          const timeAgo = age < 60 ? `${age}秒前` : age < 3600 ? `${Math.round(age / 60)}分钟前` : `${Math.round(age / 3600)}小时前`;

          const parts = [
            `使用缓存图片（来源：${imageSource}）`,
            analysisNote || '',
            '',
            `内容分析（${timeAgo}的分析结果）：`,
            cachedAnalysis.description,
          ].filter(Boolean);

          return parts.join('\n');
        }
      }

      // 6. 获取窗口信息（从缓存）
      let windowInfo: { processName?: string; windowTitle?: string } | undefined;
      if (cacheManager) {
        const cached = getCachedWindowInfo(cacheManager, hwnd);
        if (cached) {
          windowInfo = {
            windowTitle: cached.title,
          };
        }
      }

      // 7. 获取上次的分析结果（从缓存，用于增量分析）
      let previousAnalysis: string | undefined;
      if (cacheManager) {
        const cachedAnalysis = cacheManager.getAnalysis(hwnd);
        if (cachedAnalysis) {
          previousAnalysis = cachedAnalysis.description;
        }
      }

      // 8. 视觉理解
      try {
        const description = await understandImage(
          imageToAnalyze,
          client,
          model,
          windowInfo,
          previousAnalysis
        );

        const parts = [
          `截图成功（${captureResult.width ?? '?'}x${captureResult.height ?? '?'}，来源：${imageSource}）`,
        ];

        if (analysisNote) {
          parts.push(analysisNote);
        }

        parts.push('');
        parts.push('内容分析：');
        parts.push(description);

        return parts.join('\n');
      } catch (error) {
        return `视觉理解失败：${error}`;
      }
    },
  });
}

/**
 * 创建高级视觉理解工具（9B 模型）
 * 支持缓存回退：截图失败或纯色图时使用缓存图片
 */
export function createCaptureAndUnderstandAdvancedTool(
  client: OpenAI,
  model: string,
  pythonPath: string = 'python',
  pythonArgs?: string[],
  cacheManager?: VisualCacheManager | null
): Tool {
  return createTool({
    name: 'capture_and_understand_window_advanced',
    description: '使用高级视觉模型（9B）截取指定窗口的截图并进行深度理解。提供更准确的内容识别和分析。输入参数为窗口句柄（HWND），如 "0x12345" 或 "12345"。',
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
      // 1. 尝试截图（与基础工具相同的逻辑）
      let captureResult = await captureWindow(hwnd, pythonPath, pythonArgs);

      let imageToAnalyze = captureResult.data;
      let imageSource = '新截图';
      let analysisNote = '';
      let usedCachedImage = false;

      // 2. 如果截图失败，尝试使用缓存
      if (captureResult.error || !captureResult.data) {
        if (cacheManager) {
          console.log(`[capture_and_understand_window_advanced] Screenshot failed for ${hwnd}, trying cache...`);
          const cachedImage = getCachedImageBase64(cacheManager, hwnd);
          if (cachedImage) {
            imageToAnalyze = cachedImage;
            imageSource = '缓存图片';
            usedCachedImage = true;
            analysisNote = `[使用缓存图片，因为截图失败：${captureResult.error}]`;
            console.log(`[capture_and_understand_window_advanced] Using cached image for ${hwnd}`);
          } else {
            return `截图失败且无缓存可用：${captureResult.error ?? '未知错误'}`;
          }
        } else {
          return `截图失败：${captureResult.error ?? '未知错误'}`;
        }
      }

      // 3. 检查是否为纯色图
      if (imageToAnalyze && isSolidColorImage(imageToAnalyze)) {
        console.log(`[capture_and_understand_window_advanced] Detected solid color image for ${hwnd}, trying cache...`);
        if (cacheManager) {
          const cachedImage = getCachedImageBase64(cacheManager, hwnd);
          if (cachedImage) {
            imageToAnalyze = cachedImage;
            imageSource = '缓存图片';
            usedCachedImage = true;
            analysisNote = '[使用缓存图片，因为新截图是纯色图（窗口可能被最小化或遮挡）]';
            console.log(`[capture_and_understand_window_advanced] Using cached image for ${hwnd} (solid color detected)`);
          }
        }
      }

      // 4. 如果没有可用的图片
      if (!imageToAnalyze) {
        return '无法获取可用的图片进行分析';
      }

      // 5. 缓存去重：如果使用了缓存图片，检查是否已有该模型的分析结果
      if (usedCachedImage && cacheManager) {
        const cachedAnalysis = getCachedAnalysisForModel(cacheManager, hwnd, model);
        if (cachedAnalysis) {
          // 直接返回缓存的分析结果，不需要重新调用模型
          const age = Math.round((Date.now() - cachedAnalysis.createdAt) / 1000);
          const timeAgo = age < 60 ? `${age}秒前` : age < 3600 ? `${Math.round(age / 60)}分钟前` : `${Math.round(age / 3600)}小时前`;

          const parts = [
            `[高级模型] 使用缓存图片（来源：${imageSource}）`,
            analysisNote || '',
            '',
            `内容分析（${timeAgo}的分析结果）：`,
            cachedAnalysis.description,
          ].filter(Boolean);

          return parts.join('\n');
        }
      }

      // 6. 获取窗口信息
      let windowInfo: { processName?: string; windowTitle?: string } | undefined;
      if (cacheManager) {
        const cached = getCachedWindowInfo(cacheManager, hwnd);
        if (cached) {
          windowInfo = {
            windowTitle: cached.title,
          };
        }
      }

      // 7. 获取上次的分析结果（用于增量分析）
      let previousAnalysis: string | undefined;
      if (cacheManager) {
        const cachedAnalysis = cacheManager.getAnalysis(hwnd);
        if (cachedAnalysis) {
          previousAnalysis = cachedAnalysis.description;
        }
      }

      // 8. 高级视觉理解
      try {
        const description = await understandImage(
          imageToAnalyze,
          client,
          model,
          windowInfo,
          previousAnalysis
        );

        const parts = [
          `[高级模型] 截图成功（${captureResult.width ?? '?'}x${captureResult.height ?? '?'}，来源：${imageSource}）`,
        ];

        if (analysisNote) {
          parts.push(analysisNote);
        }

        parts.push('');
        parts.push('内容分析：');
        parts.push(description);

        return parts.join('\n');
      } catch (error) {
        return `视觉理解失败：${error}`;
      }
    },
  });
}

/**
 * VisualFeature 类型定义
 */

/**
 * 窗口信息（从 Python enum.py 返回）
 */
export interface WindowInfo {
  /** 窗口句柄（16进制格式，如 "0x12345"） */
  hwnd: string;
  /** 窗口标题 */
  title: string;
  /** 窗口类名 */
  class_name: string;
  /** 窗口状态 */
  status: 'Normal' | 'Minimized' | 'Maximized' | 'Unknown';
  /** 窗口位置和尺寸 */
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 进程名称 */
  process_name: string;
  /** 进程路径 */
  process_path: string;
  /** 进程 ID */
  pid: number | string;
  /** 是否置顶 */
  is_always_on_top: boolean;
}

/**
 * 截图结果（从 Python capture.py 返回）
 */
export interface CaptureResult {
  /** 是否成功 */
  success?: boolean;
  /** 窗口句柄 */
  hwnd?: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 图片格式 */
  format?: string;
  /** base64 编码的图片数据 */
  data?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 视觉理解结果（从 LLM 返回）
 */
export interface VisualUnderstandingResult {
  /** 图片内容的自然语言描述 */
  description: string;
  /** 检测到的 UI 元素（可选） */
  elements?: Array<{
    type: string;
    label?: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;
  /** 图片类型/应用类型识别（可选） */
  app_type?: string;
}

/**
 * VisualFeature 配置
 */
export interface VisualFeatureConfig {
  /** LLM 服务地址（默认 localhost:7575） */
  baseUrl?: string;
  /** 视觉理解模型名称（默认 Qwen3.5-4B-Q5_K_M） */
  model?: string;
  /**
   * Python 可执行文件路径（默认 'python'）
   *
   * 常用选项：
   * - 'python' - 系统默认 Python
   * - 'uv python' - uv 管理的 Python
   * - 'uv' - 使用 uv run（需要配置 pythonArgs）
   * - 完整路径如 'C:\\Python312\\python.exe'
   */
  pythonPath?: string;
  /**
   * Python 参数（可选）
   *
   * 例如使用 uv run：
   * pythonArgs: ['run', '--with', 'pywin32', '--with', 'psutil', '--with', 'Pillow', 'script.py']
   */
  pythonArgs?: string[];
  /**
   * 窗口进程忽略规则文件路径（可选）
   *
   * 默认使用项目根目录下的 .agentdev/windows.ignore
   * 文件格式：每行一个需要忽略的 exe 路径，支持通配符 *
   *
   * 示例：
   * ```
   * # 系统组件
   * C:\Windows\explorer.exe
   * # 输入法
   * C:\Windows\System32\ctfmon.exe
   * # 通配符匹配
   * C:\Program Files\WindowsApps\Microsoft.InputApp_*
   * ```
   */
  ignoreFilePath?: string;
  /** 是否启用 onCallStart 窗口状态注入（默认 true） */
  enableWindowInfo?: boolean;
  /** 是否在初始化时检测 Python 环境（默认 true） */
  checkPythonEnv?: boolean;
}

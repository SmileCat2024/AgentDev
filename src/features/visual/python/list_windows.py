r"""
窗口枚举脚本
参考 D:\code\AgentPaw\agent.py
输出 JSON 格式的窗口列表

支持通过 windows.ignore 文件过滤不需要的窗口进程
"""
import sys
import io
import json
import os
import fnmatch
from pathlib import Path
import win32gui
import win32process
import win32con
import psutil

# 设置 UTF-8 输出
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def load_ignore_patterns(ignore_file_path):
    """
    加载忽略规则文件
    返回通配符模式列表
    """
    if not os.path.exists(ignore_file_path):
        return []

    patterns = []
    try:
        with open(ignore_file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                # 跳过空行和注释
                if not line or line.startswith('#'):
                    continue
                # 转换为小写以进行大小写不敏感匹配
                patterns.append(line.lower())
    except Exception as e:
        print(f"Warning: Failed to read ignore file: {e}", file=sys.stderr)

    return patterns

def should_ignore_process(process_path, ignore_patterns):
    """
    检查进程路径是否应该被忽略
    支持通配符匹配
    """
    if not process_path or process_path == "N/A":
        return False

    process_path_lower = process_path.lower()

    for pattern in ignore_patterns:
        if fnmatch.fnmatch(process_path_lower, pattern):
            return True

    return False

def get_window_info(hwnd, ignore_patterns):
    """提取单个窗口的深度信息"""
    if not win32gui.IsWindowVisible(hwnd):
        return None

    # 基础信息：标题和类名
    title = win32gui.GetWindowText(hwnd)
    class_name = win32gui.GetClassName(hwnd)

    if not title:  # 过滤掉无标题的背景窗口
        return None

    # 几何信息：窗口在屏幕上的绝对坐标
    rect = win32gui.GetWindowRect(hwnd)
    width = rect[2] - rect[0]
    height = rect[3] - rect[1]

    # 状态信息：是否最小化、最大化
    placement = win32gui.GetWindowPlacement(hwnd)
    status_map = {1: "Normal", 2: "Minimized", 3: "Maximized"}
    status = status_map.get(placement[1], "Unknown")

    # 进程信息
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        proc = psutil.Process(pid)
        process_name = proc.name()
        process_path = proc.exe()
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        process_name = "N/A"
        process_path = "N/A"
        pid = "N/A"

    # 检查是否应该忽略此进程
    if should_ignore_process(process_path, ignore_patterns):
        return None

    # 层级信息：是否置顶
    ex_style = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
    is_always_on_top = bool(ex_style & win32con.WS_EX_TOPMOST)

    return {
        "hwnd": f"{hwnd:#x}",  # 16进制格式
        "title": title,
        "class_name": class_name,
        "status": status,
        "position": {"x": rect[0], "y": rect[1], "width": width, "height": height},
        "process_name": process_name,
        "process_path": process_path,
        "pid": pid,
        "is_always_on_top": is_always_on_top
    }

def enumerate_all_windows(ignore_patterns):
    """枚举所有可见窗口"""
    results = []

    def callback(hwnd, extra):
        info = get_window_info(hwnd, ignore_patterns)
        if info:
            results.append(info)
        return True

    win32gui.EnumWindows(callback, None)
    return results

def get_default_ignore_path():
    """获取默认的 ignore 文件路径"""
    # 获取项目根目录（.agentdev 目录的父目录）
    script_dir = Path(__file__).parent.parent.parent.parent.parent
    return script_dir / ".agentdev" / "windows.ignore"

if __name__ == "__main__":
    # 获取 ignore 文件路径
    if len(sys.argv) > 1:
        ignore_path = sys.argv[1]
    else:
        ignore_path = get_default_ignore_path()

    # 加载忽略规则
    ignore_patterns = load_ignore_patterns(ignore_path)

    if ignore_patterns:
        print(f"// Loaded {len(ignore_patterns)} ignore patterns from {ignore_path}", file=sys.stderr)

    # 枚举窗口
    windows = enumerate_all_windows(ignore_patterns)
    print(json.dumps(windows, ensure_ascii=False, indent=2))

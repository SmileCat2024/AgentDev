r"""
获取当前焦点窗口句柄

输出：
- 焦点窗口的16进制HWND（如 "0xe0a06"）
- 如果没有焦点窗口或出错，输出空字符串
"""
import sys
import io
import win32gui

# 设置 UTF-8 输出
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def get_foreground_window():
    """获取当前焦点窗口句柄"""
    try:
        hwnd = win32gui.GetForegroundWindow()
        if hwnd and win32gui.IsWindow(hwnd):
            return f"{hwnd:#x}"
        return ""
    except:
        return ""

if __name__ == "__main__":
    hwnd = get_foreground_window()
    print(hwnd)

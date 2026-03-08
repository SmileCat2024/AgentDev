r"""
窗口截图脚本
参考 D:\code\AgentPaw\snap.py
输出 base64 编码的 PNG 图片（不保存到本地）
"""
import sys
import io
import base64
import ctypes
from ctypes import windll, byref, Structure, sizeof
from ctypes.wintypes import RECT
import win32gui
import win32ui
import win32con
from PIL import Image

# 设置 UTF-8 输出
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
# 设置 UTF-8 输入
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')

# 解决 DPI 缩放导致的模糊和尺寸错误
ctypes.windll.shcore.SetProcessDpiAwareness(1)

def get_true_rect(hwnd):
    """获取剔除阴影后的真实窗口坐标 (物理像素)"""
    rect = RECT()
    # DWMWA_EXTENDED_FRAME_BOUNDS = 9
    ctypes.windll.dwmapi.DwmGetWindowAttribute(
        hwnd, 9, byref(rect), sizeof(rect)
    )
    return rect.left, rect.top, rect.right, rect.bottom

def capture_window_to_base64(hwnd_input):
    """
    截取指定窗口并返回 base64 编码的 PNG
    """
    try:
        hwnd = int(hwnd_input, 16) if hwnd_input.startswith('0x') else int(hwnd_input)
    except ValueError:
        return {"error": f"Invalid HWND: {hwnd_input}"}

    if not win32gui.IsWindow(hwnd):
        return {"error": f"Window not found: {hwnd_input}"}

    try:
        # 获取两组坐标
        full_left, full_top, full_right, full_bot = win32gui.GetWindowRect(hwnd)
        true_left, true_top, true_right, true_bot = get_true_rect(hwnd)

        full_w = full_right - full_left
        full_h = full_bot - full_top
        true_w = true_right - true_left
        true_h = true_bot - true_top

        # 准备设备上下文
        hwndDC = win32gui.GetWindowDC(hwnd)
        mfcDC = win32ui.CreateDCFromHandle(hwndDC)
        saveDC = mfcDC.CreateCompatibleDC()

        saveBitMap = win32ui.CreateBitmap()
        saveBitMap.CreateCompatibleBitmap(mfcDC, full_w, full_h)
        saveDC.SelectObject(saveBitMap)

        # 使用 PrintWindow 抓取全量区域
        result = ctypes.windll.user32.PrintWindow(hwnd, saveDC.GetSafeHdc(), 3)

        if result != 1:
            return {"error": "PrintWindow failed"}

        # 转换数据并裁剪
        bmpinfo = saveBitMap.GetInfo()
        bmpstr = saveBitMap.GetBitmapBits(True)
        im = Image.frombuffer(
            'RGB',
            (bmpinfo['bmWidth'], bmpinfo['bmHeight']),
            bmpstr,
            'raw',
            'BGRX',
            0,
            1
        )

        # 计算真实内容相对于全量截图的偏移
        offset_x = true_left - full_left
        offset_y = true_top - full_top
        # 裁剪：(左, 上, 右, 下)
        im_cropped = im.crop((offset_x, offset_y, offset_x + true_w, offset_y + true_h))

        # 转换为 base64
        buffer = io.BytesIO()
        im_cropped.save(buffer, format='PNG')
        img_bytes = buffer.getvalue()
        img_base64 = base64.b64encode(img_bytes).decode('utf-8')

        # 释放资源
        win32gui.DeleteObject(saveBitMap.GetHandle())
        saveDC.DeleteDC()
        mfcDC.DeleteDC()
        win32gui.ReleaseDC(hwnd, hwndDC)

        return {
            "success": True,
            "hwnd": f"{hwnd:#x}",
            "width": true_w,
            "height": true_h,
            "format": "png",
            "data": img_base64
        }

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: capture.py <HWND>"}))
    else:
        import json
        result = capture_window_to_base64(sys.argv[1])
        print(json.dumps(result, ensure_ascii=False))

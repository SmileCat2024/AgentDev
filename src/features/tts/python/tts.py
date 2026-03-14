#!/usr/bin/env python3
"""
Kokoro TTS 文本朗读脚本
使用 Kokoro-82M 模型进行中英文混合文本朗读

特性：
- 自动检测中英文混合文本
- 分别使用中文模型(zh)和英文模型(a)生成
- 自动拼接音频段

依赖：
- kokoro: TTS 模型
- soundfile: 音频文件读写
- pygame: 音频播放（可选）

安装：
pip install kokoro soundfile pygame
"""

import sys
import json
import io
import os
import re

# 重定向输出流 - 确保 stdout 只有 JSON，其他都到 stderr
class StdoutFilter:
    """只允许 JSON 输出通过"""
    def __init__(self, original_stdout):
        self.original_stdout = original_stdout
        self.buffer = []
        
    def write(self, text):
        # 缓存所有写入
        self.buffer.append(text)
        
    def flush(self):
        # flush 时不做任何事，等待显式 JSON 输出
        pass
        
    def write_json(self, data):
        """显式写入 JSON"""
        json_str = json.dumps(data, ensure_ascii=False)
        self.original_stdout.write(json_str + '\n')
        self.original_stdout.flush()

# 重定向 stdout
original_stdout = sys.stdout
sys.stdout = StdoutFilter(original_stdout)

# 重定向 stderr 到原始 stderr，但抑制警告
import warnings
warnings.filterwarnings('ignore')
import logging
logging.basicConfig(level=logging.ERROR)

# 设置环境变量以抑制 HF Hub 警告
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
os.environ['PYTHONWARNINGS'] = 'ignore'

# 抑制 jieba 的 DEBUG 日志
class LoggingFilter:
    """过滤掉 DEBUG 级别的日志"""
    def __init__(self, original_stderr):
        self.original_stderr = original_stderr
        
    def write(self, text):
        # 过滤 DEBUG 日志
        if 'DEBUG:' not in text:
            self.original_stderr.write(text)
            
    def flush(self):
        self.original_stderr.flush()

# 设置 UTF-8 输入
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')

# 先包装 stderr
_raw_stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
sys.stderr = LoggingFilter(_raw_stderr)

def log(message):
    """输出日志到 stderr"""
    sys.stderr.write(str(message) + '\n')
    sys.stderr.flush()

def split_text_for_bilingual(text):
    """
    分割中英文混合文本，返回纯语言块列表

    规则：
    - 中文字符范围：\u4e00-\u9fff
    - 非中文字符视为英文/符号块
    - 连续的相同语言字符归为同一块

    例如：
    "你好Hello世界" -> ["你好", "Hello", "世界"]
    """
    # 按语言边界分割：中文块 vs 英文/符号块
    parts = re.split(r'([^\u4e00-\u9fff\s]+)', text)
    # 过滤空块并去除首尾空白
    return [p.strip() for p in parts if p.strip()]

def is_chinese(text):
    """判断文本是否包含中文字符"""
    return any('\u4e00' <= c <= '\u9fff' for c in text)

def main():
    """
    从 stdin 读取 JSON 配置，生成音频并输出结果
    
    输入 JSON 格式：
    {
        "text": "要朗读的文本",
        "voice": "声音ID (默认: zf_xiaobei)",
        "lang": "语言代码 (默认: zh，自动检测中英文)",
        "speed": 1.2,
        "output": "输出文件路径 (默认: output.wav)",
        "autoPlay": true
    }
    
    输出 JSON 格式：
    {
        "success": true,
        "output_path": "/path/to/output.wav",
        "duration": 1.23
    }
    
    或错误：
    {
        "success": false,
        "error": "错误信息"
    }
    """
    try:
        # 从 stdin 读取配置
        input_data = sys.stdin.read()
        if not input_data.strip():
            sys.stdout.write_json({"success": False, "error": "No input data"})
            sys.exit(1)
        
        config = json.loads(input_data)
        
        text = config.get('text', '')
        if not text:
            sys.stdout.write_json({"success": False, "error": "No text provided"})
            sys.exit(1)
        
        voice = config.get('voice', 'zf_xiaobei')
        lang = config.get('lang', 'zh')
        speed = config.get('speed', 1.2)
        output_path = config.get('output', 'output.wav')
        
        # 动态导入 kokoro（只在需要时加载）
        try:
            from kokoro import KPipeline
            import soundfile as sf
            import numpy as np
            from pathlib import Path
        except ImportError as e:
            sys.stdout.write_json({
                "success": False,
                "error": f"Missing required library: {str(e)}"
            })
            sys.exit(1)

        # 尝试导入 pygame 用于播放（可选）
        try:
            import pygame
            pygame.mixer.init(frequency=24000, size=-16, channels=1, buffer=512)
            has_pygame = True
        except ImportError:
            has_pygame = False
            log("[Kokoro] pygame not available, skipping auto-play")

        # 分割中英文混合文本
        text_parts = split_text_for_bilingual(text)
        log(f"[Kokoro] Text split into {len(text_parts)} part(s)")

        # 检测需要哪些语言模型
        has_chinese = any(is_chinese(part) for part in text_parts)
        has_english = any(not is_chinese(part) for part in text_parts)

        # 只初始化中文 pipeline（总是需要，作为回退）
        pipelines = {}
        try:
            pipelines['zh'] = KPipeline(lang_code='zh')
            log(f"[Kokoro] Initialized pipeline for lang=zh")
        except Exception as e:
            sys.stdout.write_json({
                "success": False,
                "error": f"Failed to initialize Chinese pipeline: {str(e)}"
            })
            sys.exit(1)

        # 尝试初始化英文 pipeline（如果需要）
        if has_english:
            try:
                pipelines['a'] = KPipeline(lang_code='a')
                log(f"[Kokoro] Initialized pipeline for lang=a")
            except Exception as e:
                # 英文模型初始化失败（通常是网络问题），回退到只用中文
                log(f"[Kokoro] Failed to initialize English pipeline: {e}")
                log(f"[Kokoro] Falling back to Chinese pipeline for all text")
                has_english = False  # 标记为没有英文，强制使用中文

        # 收集所有音频段
        audio_segments_all = []

        for i, part in enumerate(text_parts):
            # 判断该块使用哪种语言模型
            if is_chinese(part):
                pipe = pipelines['zh']
                part_lang = 'zh'
            elif has_english and 'a' in pipelines:
                pipe = pipelines['a']
                part_lang = 'a'
            else:
                # 回退到中文模型处理英文
                pipe = pipelines['zh']
                part_lang = 'zh (fallback)'

            log(f"[Kokoro] Part {i+1}/{len(text_parts)} (lang={part_lang}, {len(part)} chars): {part[:30]}...")

            # 生成该部分的音频
            generator = pipe(part, voice=voice, speed=speed)

            # 收集该部分的音频段
            for gs, ps, audio_tensor in generator:
                audio_np = audio_tensor.cpu().numpy()
                audio_segments_all.append(audio_np)

        # 拼接所有音频段
        if len(audio_segments_all) > 1:
            audio = np.concatenate(audio_segments_all)
        else:
            audio = audio_segments_all[0]
        
        # 计算时长（秒）
        sample_rate = 24000  # Kokoro 默认采样率
        duration = len(audio) / sample_rate
        
        # 保存文件
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        sf.write(output_file, audio, sample_rate)

        log(f"[Kokoro] Audio saved to {output_file.absolute()} ({duration:.2f}s)")

        # 自动播放音频（如果启用且 pygame 可用）
        auto_play = config.get('autoPlay', True)
        if auto_play and has_pygame:
            try:
                log("[Kokoro] Playing audio...")
                pygame.mixer.music.load(str(output_file))
                pygame.mixer.music.play()
                # 等待播放完成
                while pygame.mixer.music.get_busy():
                    pygame.time.Clock().tick(10)
                log("[Kokoro] Playback completed")
            except Exception as e:
                log(f"[Kokoro] Playback failed: {e}")
        elif auto_play and not has_pygame:
            log("[Kokoro] Auto-play requested but pygame not installed")
            log("[Kokoro] Install with: pip install pygame")

        # 返回成功结果
        sys.stdout.write_json({
            "success": True,
            "output_path": str(output_file.absolute()),
            "duration": duration
        })
        
    except Exception as e:
        import traceback
        error_details = f"{str(e)}\n{traceback.format_exc()}"
        log(f"[Kokoro] Error: {error_details}")
        
        sys.stdout.write_json({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        })
        sys.exit(1)

if __name__ == "__main__":
    main()

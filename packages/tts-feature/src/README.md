# TTSFeature - 文本朗读功能

提供文本朗读能力，支持在非工具调用轮自动朗读模型输出。

## 功能特性

- **自动朗读**：在非工具调用轮结束时自动朗读模型输出的正文部分
- **中英文混合**：基于 Kokoro-82M 模型，支持中英文混合文本朗读
- **多种声音**：支持多种中文和英文声音（如 zf_xiaobei、zf_xiaoxiao、af_bella 等）
- **灵活配置**：可配置语速、声音、语言、触发条件等
- **环境检测**：自动检测 Python 环境和依赖库

## Python 环境要求

### 必需库

```bash
# 核心依赖
uv pip install kokoro soundfile

# 中文 TTS 额外依赖
uv pip install ordered-set pypinyin cn2an jieba
```

**一键安装所有依赖：**
```bash
uv pip install kokoro soundfile ordered-set pypinyin cn2an jieba
```

### 完整依赖列表

- **kokoro** >= 0.9.4 - TTS 模型
- **soundfile** - 音频文件处理
- **ordered-set** - 数据结构
- **pypinyin** - 拼音转换
- **cn2an** - 中文数字转换
- **jieba** - 中文分词
- **torch** - 深度学习框架（自动安装）
- **numpy** - 数值计算（自动安装）

### 可选库（用于实时播放）

```bash
# 如果想实时播放声音（而不是只保存文件）
pip install pydub  # 需要 ffmpeg 支持
```

### 推荐安装方式

**使用 uv（推荐）：**

```bash
uv pip install kokoro soundfile
```

**使用 pip：**

```bash
pip install kokoro soundfile
```

## 使用示例

### 基础使用

```typescript
import { TTSFeature } from './features/index.js';

// 使用默认配置
const agent = new Agent({ ... }).use(new TTSFeature());
```

### 自定义声音和语速

```typescript
const agent = new Agent({ ... }).use(new TTSFeature({
  model: {
    voice: 'zf_xiaoxiao',  // 女声
    lang: 'zh',             // 中文优先
    speed: 1.2              // 语速 1.2 倍
  }
}));
```

### 使用 uv 运行 Python

```typescript
const agent = new Agent({ ... }).use(new TTSFeature({
  pythonPath: 'uv',
  pythonArgs: ['run', '--with', 'kokoro', '--with', 'soundfile']
}));
```

### 自定义触发条件

```typescript
const agent = new Agent({ ... }).use(new TTSFeature({
  triggers: {
    autoEnabled: true,              // 启用自动朗读
    minLength: 20,                  // 最少 20 个字符
    maxLength: 500,                 // 最多 500 个字符（超过会截断）
    onlyOnNonToolCalls: true        // 只在非工具调用轮朗读
  }
}));
```

### 自定义输出目录

```typescript
const agent = new Agent({ ... }).use(new TTSFeature({
  output: {
    outputDir: './tts-output',      // 输出目录
    autoPlay: false                 // 是否自动播放（暂未实现）
  }
}));
```

## 配置选项

### `TTSFeatureConfig`

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `pythonPath` | `string` | `.venv/python` 或 `python` | Python 可执行文件路径 |
| `pythonArgs` | `string[]` | `undefined` | Python 额外参数（如 uv run） |
| `checkPythonEnv` | `boolean` | `true` | 是否在初始化时检查 Python 环境 |
| `model` | `object` | - | TTS 模型配置 |
| `model.voice` | `string` | `'zf_xiaobei'` | 默认声音 ID |
| `model.lang` | `string` | `'zh'` | 语言代码（'zh' 或 'en'） |
| `model.speed` | `number` | `1.0` | 语速倍率（0.8~1.5） |
| `output` | `object` | - | 音频输出配置 |
| `output.outputDir` | `string` | 临时目录 | 输出目录 |
| `output.autoPlay` | `boolean` | `false` | 是否自动播放 |
| `triggers` | `object` | - | TTS 触发条件 |
| `triggers.autoEnabled` | `boolean` | `true` | 是否启用自动朗读 |
| `triggers.minLength` | `number` | `10` | 最小文本长度 |
| `triggers.maxLength` | `number` | `1000` | 最大文本长度 |
| `triggers.onlyOnNonToolCalls` | `boolean` | `true` | 是否只在非工具调用轮触发 |

## 可用声音

### 中文声音

- `zf_xiaobei` - 女声（推荐）
- `zf_xiaoxiao` - 女声
- `zf_xiaomei` - 女声
- `zm_xiaoming` - 男声

### 英文声音

- `af_bella` - 女声
- `af_heart` - 女声
- `am_michael` - 男声

更多声音列表：https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md

## 工作原理

1. **StepFinish 钩子**：在每个 ReAct 步骤结束时触发
2. **内容提取**：提取模型输出的正文部分（排除系统消息和工具调用）
3. **长度检查**：检查文本长度是否符合配置的最小/最大长度
4. **TTS 生成**：调用 Python 脚本生成音频文件
5. **状态跟踪**：记录朗读历史和统计信息

## 注意事项

1. **首次运行**：首次运行时会自动下载 Kokoro-82M 模型（约 300MB）
2. **espeak-ng**：中文朗读需要 espeak-ng 支持，否则可能效果较差
3. **性能**：TTS 生成需要一定时间（取决于文本长度和硬件）
4. **临时文件**：生成的音频文件保存在临时目录，重启后自动清理
5. **网络**：首次下载模型需要网络连接

## 调试

### 查看 TTS 日志

```typescript
// TTSFeature 会输出详细的日志信息
[TTSFeature] Initialized with voice=zf_xiaobei, lang=zh, pythonPath=python
[TTSFeature] ✓ Python environment check passed
[TTSFeature] Generating TTS for 123 characters...
[TTSFeature] ✓ TTS generated: /tmp/tts-xxx.wav (3.45s)
```

### Python 环境检查失败

如果看到环境检查失败警告：

```
[TTSFeature] ⚠ Python environment check failed:
Required Python libraries: kokoro, soundfile

Install with uv:
  uv pip install kokoro soundfile

Or with pip:
  pip install kokoro soundfile
```

请按照提示安装所需库。

## 故障排除

### 问题：无法启动 Python

**错误信息**：`Failed to spawn Python`

**解决方案**：
- 检查 `pythonPath` 配置是否正确
- 如果使用 uv，尝试：`new TTSFeature({ pythonPath: 'uv python' })`

### 问题：模型下载失败

**错误信息**：`Failed to download model`

**解决方案**：
- 检查网络连接
- 手动从 HuggingFace 下载模型
- 设置代理（如需要）

### 问题：中文朗读效果差

**解决方案**：
- 确保 espeak-ng 已安装
- Windows：通过 Chocolatey 安装 `choco install espeak-ng`
- Linux：`sudo apt-get install espeak-ng`
- macOS：`brew install espeak-ng`

## 测试

运行 TTS Feature 测试：

```bash
npm test -- src/features/tts/test/tts.test.ts
```

## 许可证

MIT

## 相关资源

- [Kokoro TTS GitHub](https://github.com/remsky/Kokoro-FastAPI)
- [Kokoro-82M 模型](https://huggingface.co/hexgrad/Kokoro-82M)
- [声音列表](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)

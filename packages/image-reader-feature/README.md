# @agentdev/image-reader-feature

图片读取 Feature，提供 `read_image` 工具，让 Agent 能主动读取本地图片文件并直接注入到对话上下文中。

## 安装

```bash
npm install @agentdev/image-reader-feature
```

## 使用

```typescript
import { ImageReaderFeature } from '@agentdev/image-reader-feature';

agent.use(new ImageReaderFeature({
  workspaceDir: '/path/to/project',
  storageDir: '/path/to/managed/images',
}));
```

## 工具

### read_image

读取本地图片文件，将图片注入到对话上下文中。支持 PNG、JPEG、GIF、WebP、BMP、SVG 格式。

**参数：**
- `path` (string, required): 图片文件路径（绝对路径或相对于工作目录的相对路径）

**返回：**
- 成功：图片被注入到上下文，文本结果显示文件信息
- 失败：错误信息（文件不存在、格式不支持、文件过大等）

## 技术细节

工具使用框架的 `withImages()` 机制返回图片数据。框架会自动处理：

- **视觉模式**（vision: true）：图片以原生格式注入到 LLM 请求中
  - Anthropic：嵌入 `tool_result.content` 数组
  - OpenAI Chat：追加一条 user 消息携带图片
  - OpenAI Responses：追加一条 user 消息携带图片
- **非视觉模式**（vision: false）：图片降级为文字占位符，模型知道有图片但无法看到内容

调用 `read_image` 时，Feature 会立即读取原文件，并按内容 SHA-256 哈希复制到受管目录。`ImageInput.path` 指向这个受管快照，而 `source` 保留原路径用于展示和非视觉占位符。这样既避免 session 内联 Base64 膨胀，也保证原文件后续修改、移动或删除不会改变历史上下文。

- `storageDir` 可由宿主指定；默认是 `~/.agentdev/images`
- 相同内容会复用同一个受管文件
- 宿主应把受管目录视为持久化会话附件，不应在会话仍可能恢复时清理

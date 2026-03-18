# Audio Feedback Feature

在每次 call 完成时播放音频反馈，提供愉悦的交互体验。

## 功能

- 自动在每次 call 完成时播放音频
- 可配置启用/禁用状态
- 可调节音量
- 支持自定义音频文件

## 使用方法

```typescript
import { AudioFeedbackFeature } from '../src/features/audio-feedback/index.js';

const agent = new ProgrammingHelperAgent({
  name: '编程小助手',
}).use(new AudioFeedbackFeature({
  enabled: true,        // 是否启用（默认：true）
  volume: 0.5,         // 音量 0-1（默认：0.5）
  audioPath: './custom.mp3',  // 自定义音频路径（可选）
}));
```

## 配置选项

- `enabled`: 是否启用音频反馈（默认：`true`）
- `volume`: 音量大小，范围 0-1（默认：`0.5`）
- `audioPath`: 自定义音频文件路径（默认：使用内置的 `media/success.mp3`）

## 公开 API

- `setEnabled(enabled: boolean)`: 启用或禁用音频反馈
- `isEnabled(): boolean`: 获取当前启用状态
- `setVolume(volume: number)`: 设置音量（0-1）
- `getPlayCount(): number`: 获取播放次数统计

## 反向钩子

- `@CallFinish`: 在每次 call 完成时播放音频

## 状态快照

支持完整的状态快照和恢复，包括：
- 启用状态
- 音量设置
- 音频路径
- 播放次数统计

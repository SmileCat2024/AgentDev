declare module 'sound-play' {
  /**
   * sound-play 模块
   * 提供跨平台音频播放功能
   */
  interface SoundPlayModule {
    /**
     * 播放音频文件
     * @param filePath 音频文件路径
     * @param volume 音量（0-1），默认 0.5
     * @returns Promise<void>
     */
    play(filePath: string, volume?: number): Promise<void>;
  }

  const soundPlay: SoundPlayModule;
  export default soundPlay;
}

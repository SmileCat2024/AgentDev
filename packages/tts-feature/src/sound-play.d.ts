declare module 'sound-play' {
  export function play(filePath: string, volume?: number): Promise<void>;
}

/**
 * 浏览器全局变量类型声明
 * 用于 .render.ts 文件中使用的浏览器环境库
 */

declare global {
  /**
   * highlight.js - 代码语法高亮
   */
  const hljs: {
    highlight(code: string, options: { language: string }): { value: string };
    highlightAuto(code: string): { value: string };
    getLanguage(name: string): boolean;
  };

  /**
   * marked - Markdown 解析器
   */
  const marked: {
    parse(markdown: string, options?: any): string;
    setOptions(options: any): void;
  };

  /**
   * Diff2Html - Diff 可视化
   */
  const Diff2Html: {
    html(diff: string, options?: {
      drawFileList?: boolean;
      matching?: 'lines' | 'words' | 'none';
      outputFormat?: 'line-by-line' | 'side-by-side';
      colorScheme?: 'light' | 'dark';
    }): string;
  };
}

export {};

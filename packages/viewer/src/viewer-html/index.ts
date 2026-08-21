/**
 * Viewer HTML Template - 调试器前端 HTML 模板（拆分版）
 *
 * 原始的单文件 viewer-html.ts 已按职责拆分为同目录下的多个模块。
 * 本文件负责将各模块按正确顺序拼接为完整的 HTML 字符串。
 */

import { VIEWER_CSS } from './css.js';
import { VIEWER_BODY } from './body.js';
import { VIEWER_JS_STATE } from './js-state.js';
import { VIEWER_JS_I18N } from './js-i18n.js';
import { VIEWER_JS_UTILS } from './js-utils.js';
import { VIEWER_JS_INSPECTOR } from './js-inspector.js';
import { VIEWER_JS_LOGS } from './js-logs.js';
import { VIEWER_JS_MCP } from './js-mcp.js';
import { VIEWER_JS_LIFECYCLE_DOCS } from './js-lifecycle-docs.js';
import { VIEWER_JS_PANELS } from './js-panels.js';
import { VIEWER_JS_UI_BASE } from './js-ui-base.js';
import { VIEWER_JS_TEMPLATES } from './js-templates.js';
import { VIEWER_JS_AGENTS } from './js-agents.js';
import { VIEWER_JS_POLL } from './js-poll.js';
import { VIEWER_JS_NOTIFICATIONS } from './js-notifications.js';
import { VIEWER_JS_CHOICE_INPUT } from './js-choice-input.js';
import { VIEWER_JS_MESSAGES } from './js-messages.js';

/**
 * 生成调试器前端页面的完整 HTML
 * @param port - HTTP 服务器端口号（保留用于 API 兼容，当前未使用）
 * @returns 完整的 HTML 字符串
 */
export function generateViewerHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Debugger</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-dark.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>

  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css">
  <script src="https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html.min.js"></script>

` + VIEWER_CSS + `</head>
` + VIEWER_BODY + `  <script>
` + VIEWER_JS_STATE
+ VIEWER_JS_I18N
+ VIEWER_JS_UTILS
+ VIEWER_JS_INSPECTOR
+ VIEWER_JS_LOGS
+ VIEWER_JS_MCP
+ VIEWER_JS_LIFECYCLE_DOCS
+ VIEWER_JS_PANELS
+ VIEWER_JS_UI_BASE
+ VIEWER_JS_TEMPLATES
+ VIEWER_JS_AGENTS
+ VIEWER_JS_POLL
+ VIEWER_JS_NOTIFICATIONS
+ VIEWER_JS_CHOICE_INPUT
+ VIEWER_JS_MESSAGES + `  </script>
</body>
</html>`;
}

/**
 * 备选方案：如果未来想改为静态 HTML 文件 + 动态变量注入
 * 可以使用此函数读取 HTML 文件并替换其中的占位符
 */
export async function loadViewerHtml(
  htmlPath: string,
  replacements: Record<string, string> = {}
): Promise<string> {
  // 未来如果改用静态 HTML 文件，可以在这里实现
  // const content = await fs.readFile(htmlPath, 'utf-8');
  // let result = content;
  // for (const [key, value] of Object.entries(replacements)) {
  //   result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  // }
  // return result;
  throw new Error('Static HTML loading not implemented yet');
}

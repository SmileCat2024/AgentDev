/**
 * OutputGuard 核心截断逻辑
 *
 * 三级级联策略：
 * 1. JSON 字段截断（保结构）：解析 JSON → 递归截断长字段值 → 裁剪数组条目 → 重新序列化
 * 2. 行感知 head+tail：按行分割，保留首尾行，中间插入标记
 * 3. 字符级 head+tail：兜底，永不失败
 *
 * 所有截断函数都保证：
 * - 不破坏外层 JSON 信封的合法性（截断发生在 string 值内部）
 * - 截断标记清晰可读，LLM 能理解数据不完整
 * - Unicode 安全（不在多字节字符中间切割）
 */

// ========== 常量 ==========

/** 默认硬限制（安全网触发阈值） */
export const DEFAULT_HARD_LIMIT = 50_000;

/** 默认单个字段截断长度（JSON 字段截断时，每个 string 值的上限） */
export const DEFAULT_FIELD_LIMIT = 5_000;

/** 截断标记保留预算（从总预算中扣除给标记文本留空间） */
const MARKER_BUDGET = 300;

// ========== 公共类型 ==========

export interface TruncateOptions {
  /** 总体积硬限制 */
  hardLimit?: number;
  /** 单个字符串字段截断长度 */
  fieldLimit?: number;
}

export interface TruncateResult {
  /** 截断后的结果字符串 */
  output: string;
  /** 是否发生了截断 */
  truncated: boolean;
  /** 使用的截断策略 */
  strategy: 'none' | 'json-fields' | 'json-array' | 'line-headtail' | 'char-headtail';
  /** 原始长度 */
  originalLength: number;
  /** 截断后长度 */
  truncatedLength: number;
}

// ========== Unicode 安全工具 ==========

/**
 * 找到不超过 maxBytes 的最后一个完整 UTF-8 字符边界。
 * JavaScript 字符串是 UTF-16，但大部分情况下用码点（code point）判断就够了。
 * 我们用 Array.from 来按 Unicode 码点分割，避免在代理对中间切割。
 */
function safeSliceFromCodePoints(str: string, maxChars: number): string {
  const codePoints = Array.from(str);
  if (codePoints.length <= maxChars) return str;
  return codePoints.slice(0, maxChars).join('');
}

function safeSliceTailFromCodePoints(str: string, maxChars: number): string {
  const codePoints = Array.from(str);
  if (codePoints.length <= maxChars) return str;
  return codePoints.slice(-maxChars).join('');
}

// ========== 截断标记 ==========

function buildMarker(omitted: number, total: number): string {
  const totalKB = Math.round(total / 1024);
  return `\n[... truncated: ${omitted} chars omitted (${totalKB}KB total) ...]\n`;
}

function buildFieldMarker(omitted: number): string {
  return ` [...${omitted} chars omitted...] `;
}

// ========== 策略 1: JSON 字段截断 ==========

/**
 * 递归遍历 JSON 节点，截断超长的 string 值。
 * 不改变结构（key、数组长度、嵌套层级不变），只缩短 string 叶子值。
 */
export function truncateJsonNode(node: unknown, fieldLimit: number): unknown {
  if (typeof node === 'string') {
    if (node.length <= fieldLimit) return node;
    const headSize = Math.floor(fieldLimit * 0.6);
    const tailSize = Math.floor(fieldLimit * 0.3);
    const head = safeSliceFromCodePoints(node, headSize);
    const tail = safeSliceTailFromCodePoints(node, tailSize);
    const omitted = node.length - head.length - tail.length;
    return head + buildFieldMarker(omitted) + tail;
  }

  if (Array.isArray(node)) {
    return node.map((item) => truncateJsonNode(item, fieldLimit));
  }

  if (node !== null && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = truncateJsonNode(value, fieldLimit);
    }
    return result;
  }

  // number, boolean, null, undefined, bigint, symbol, function → 原样返回
  return node;
}

/**
 * 裁剪数组：保留头部和尾部的元素，中间用标记元素替代。
 *
 * 标记元素是一个字符串（合法 JSON 值），格式为 `<<N items omitted>>`。
 */
export function shrinkArray(arr: unknown[], targetBudget: number): unknown[] {
  const serialized = JSON.stringify(arr);
  if (serialized.length <= targetBudget) return arr;

  const halfBudget = Math.floor(targetBudget / 2);
  const head: unknown[] = [];
  const tail: unknown[] = [];
  let headSize = 0;
  let tailSize = 0;

  // 从头部收集
  for (const item of arr) {
    const s = JSON.stringify(item);
    if (headSize + s.length + 2 > halfBudget) break; // +2 for ", "
    head.push(item);
    headSize += s.length + 2;
  }

  // 从尾部收集
  for (let i = arr.length - 1; i >= 0; i--) {
    if (head.length + tail.length >= arr.length) break; // 防止重叠
    const s = JSON.stringify(arr[i]);
    if (tailSize + s.length + 2 > halfBudget) break;
    tail.unshift(arr[i]);
    tailSize += s.length + 2;
  }

  const omitted = arr.length - head.length - tail.length;
  if (omitted <= 0) return arr;

  return [...head, `<<${omitted} items omitted>>`, ...tail];
}

/**
 * 在 JSON 对象树中寻找最长的数组并裁剪。
 * 递归遍历所有对象和数组，对每个数组尝试裁剪。
 */
function shrinkLongestArrays(node: unknown, targetBudget: number): unknown {
  if (Array.isArray(node)) {
    // 先递归处理子节点
    let processed = node.map((item) => shrinkLongestArrays(item, targetBudget));
    // 再尝试裁剪当前数组
    processed = shrinkArray(processed, targetBudget);
    return processed;
  }

  if (node !== null && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = shrinkLongestArrays(value, targetBudget);
    }
    return result;
  }

  return node;
}

/**
 * 尝试 JSON 字段截断策略。
 * 返回截断后的字符串，或 null（表示不是 JSON 或截断后仍然超限）。
 */
export function tryJsonTruncate(
  str: string,
  hardLimit: number,
  fieldLimit: number,
): { output: string; strategy: 'json-fields' | 'json-array' } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch {
    return null; // 不是合法 JSON
  }

  // 只处理 object/array，原始值（string/number/boolean/null）不在此策略范围
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  // Pass 1: 字段值截断
  const truncated = truncateJsonNode(parsed, fieldLimit);
  let serialized = JSON.stringify(truncated);

  if (serialized.length <= hardLimit) {
    return { output: serialized, strategy: 'json-fields' };
  }

  // Pass 2: 数组裁剪（逐步收紧 budget 直到达标）
  let budget = hardLimit - MARKER_BUDGET;
  let withShrunkArrays = truncateJsonNode(parsed, fieldLimit); // 从原始重新开始
  while (budget > 1000) {
    withShrunkArrays = shrinkLongestArrays(withShrunkArrays, budget);
    serialized = JSON.stringify(withShrunkArrays);
    if (serialized.length <= hardLimit) {
      return { output: serialized, strategy: 'json-array' };
    }
    budget = Math.floor(budget * 0.7); // 收紧 30%
  }

  // JSON 策略无法压到目标以下，交由上层回退
  return null;
}

// ========== 策略 2: 行感知 head+tail ==========

/**
 * 按行分割，保留首尾行，中间插入截断标记。
 * 适合多行文本（shell 输出、日志、格式化文本、pretty-printed JSON）。
 */
export function truncateByLines(str: string, limit: number): string {
  if (str.length <= limit) return str;

  const lines = str.split('\n');
  const budget = limit - MARKER_BUDGET;
  const halfBudget = Math.floor(budget / 2);

  const headLines: string[] = [];
  const tailLines: string[] = [];
  let headSize = 0;
  let tailSize = 0;

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for \n
    if (headSize + lineLen > halfBudget) break;
    headLines.push(line);
    headSize += lineLen;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (headLines.length + tailLines.length >= lines.length) break; // 防止重叠
    const lineLen = lines[i].length + 1;
    if (tailSize + lineLen > halfBudget) break;
    tailLines.unshift(lines[i]);
    tailSize += lineLen;
  }

  const omittedLines = lines.length - headLines.length - tailLines.length;
  const omittedChars = str.length - headLines.join('\n').length - tailLines.join('\n').length - 1;

  const marker = buildMarker(Math.max(0, omittedChars), str.length);
  // 在标记中也提及行数，帮助 LLM 理解规模
  const lineInfo = omittedLines > 0 ? ` (${omittedLines} of ${lines.length} lines)` : '';

  return (
    headLines.join('\n') +
    marker.slice(0, -1) + lineInfo + '\n' +
    tailLines.join('\n')
  );
}

// ========== 策略 3: 字符级 head+tail（兜底） ==========

/**
 * 纯字符级 head+tail 截断。
 * 永不失败，但不保证行/结构完整性。
 */
export function truncateHeadTail(str: string, limit: number): string {
  const budget = limit - MARKER_BUDGET;
  const headSize = Math.floor(budget * 0.6);
  const tailSize = budget - headSize;

  const head = safeSliceFromCodePoints(str, headSize);
  const tail = safeSliceTailFromCodePoints(str, tailSize);
  const omitted = str.length - head.length - tail.length;

  return head + buildMarker(omitted, str.length) + tail;
}

// ========== 主入口：级联截断 ==========

/**
 * 对工具结果字符串执行级联截断。
 *
 * 策略优先级：
 * 1. 如果不超限，直接返回
 * 2. 尝试 JSON 字段截断（保结构、保 JSON 合法性）
 * 3. 尝试行感知 head+tail（保行边界）
 * 4. 字符级 head+tail（兜底）
 *
 * 返回包含截断结果和元信息的 TruncateResult。
 */
export function truncateOutput(
  str: string,
  options?: TruncateOptions,
): TruncateResult {
  const hardLimit = options?.hardLimit ?? DEFAULT_HARD_LIMIT;
  const fieldLimit = options?.fieldLimit ?? DEFAULT_FIELD_LIMIT;
  const originalLength = str.length;

  // 不超限，直接返回
  if (originalLength <= hardLimit) {
    return {
      output: str,
      truncated: false,
      strategy: 'none',
      originalLength,
      truncatedLength: originalLength,
    };
  }

  // 策略 1: JSON 字段截断
  const jsonResult = tryJsonTruncate(str, hardLimit, fieldLimit);
  if (jsonResult !== null) {
    return {
      output: jsonResult.output,
      truncated: true,
      strategy: jsonResult.strategy,
      originalLength,
      truncatedLength: jsonResult.output.length,
    };
  }

  // 策略 2: 行感知 head+tail
  // 仅当文本有足够的行数时使用（否则行分割本身就是开销）
  const lineCount = str.split('\n').length;
  if (lineCount >= 5) {
    const lineResult = truncateByLines(str, hardLimit);
    if (lineResult.length <= hardLimit) {
      return {
        output: lineResult,
        truncated: true,
        strategy: 'line-headtail',
        originalLength,
        truncatedLength: lineResult.length,
      };
    }
  }

  // 策略 3: 字符级 head+tail（兜底，永不失败）
  const fallback = truncateHeadTail(str, hardLimit);
  return {
    output: fallback,
    truncated: true,
    strategy: 'char-headtail',
    originalLength,
    truncatedLength: fallback.length,
  };
}

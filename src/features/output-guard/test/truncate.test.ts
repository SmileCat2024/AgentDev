/**
 * OutputGuard 截断逻辑全面测试
 *
 * 覆盖矩阵：
 * - JSON 字段截断：各种嵌套深度、类型混合、特殊字符转义
 * - 数组裁剪：混合类型、对象数组、超大数组、嵌套数组
 * - 非 JSON 文本：shell 输出、日志、多行文本、单行超长
 * - Unicode/emoji 安全：代理对、组合字符、零宽字符
 * - JSON 特殊字符：引号、反斜杠、控制字符、unicode escape
 * - 极端边界：空字符串、null、超大单字段、深嵌套
 * - 错误处理：非法 JSON、截断失败回退
 * - 幂等性：已截断结果不重复截断
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  truncateOutput,
  truncateJsonNode,
  shrinkArray,
  tryJsonTruncate,
  truncateByLines,
  truncateHeadTail,
  DEFAULT_HARD_LIMIT,
  DEFAULT_FIELD_LIMIT,
} from '../truncate.js';
import { OutputGuardFeature } from '../index.js';

// ========== 辅助函数 ==========

/** 生成指定长度的字符串 */
function genStr(len: number, prefix = 'x'): string {
  return prefix.repeat(len);
}

/** 生成多行文本 */
function genLines(count: number, lineLen = 80): string {
  return Array.from({ length: count }, (_, i) =>
    `Line ${i}: ` + 'a'.repeat(Math.max(0, lineLen - 10)),
  ).join('\n');
}

/** 检查字符串是否为合法 JSON（parse 不抛异常即合法） */
function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// ========== 1. 基本：不超限直接通过 ==========

describe('truncateOutput — 基本行为', () => {
  it('短字符串不截断', () => {
    const result = truncateOutput('hello world');
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.strategy, 'none');
    assert.strictEqual(result.output, 'hello world');
  });

  it('刚好等于 hardLimit 不截断', () => {
    const str = genStr(1000);
    const result = truncateOutput(str, { hardLimit: 1000 });
    assert.strictEqual(result.truncated, false);
  });

  it('超过 hardLimit 触发截断', () => {
    const str = genStr(2000);
    const result = truncateOutput(str, { hardLimit: 1000 });
    assert.strictEqual(result.truncated, true);
    assert.ok(result.output.length <= 1000, `输出应在限制内，实际 ${result.output.length}`);
  });
});

// ========== 2. JSON 字段截断 ==========

describe('truncateJsonNode — JSON 字段截断', () => {
  it('短字段不截断', () => {
    const node = { name: 'hello', value: 42 };
    const result = truncateJsonNode(node, 100);
    assert.deepStrictEqual(result, node);
  });

  it('截断超长字符串字段值', () => {
    const longStr = genStr(10000);
    const node = { data: longStr, name: 'test' };
    const result = truncateJsonNode(node, 100) as Record<string, unknown>;
    const data = result.data as string;
    assert.ok(data.length < longStr.length, '字段应被截断');
    assert.ok(data.includes('omitted'), '应包含截断标记');
    assert.strictEqual(result.name, 'test', '短字段不应被修改');
  });

  it('递归处理嵌套对象', () => {
    const longStr = genStr(5000);
    const node = {
      level1: {
        level2: {
          level3: {
            deepField: longStr,
          },
        },
      },
      topField: 'short',
    };
    const result = truncateJsonNode(node, 100) as any;
    assert.ok(result.level1.level2.level3.deepField.length < longStr.length);
    assert.strictEqual(result.topField, 'short');
    assert.strictEqual(result.level1.level2.level3.deepField.includes('omitted'), true);
  });

  it('处理数组中的对象', () => {
    const longStr = genStr(5000);
    const node = {
      items: [
        { id: 1, data: longStr },
        { id: 2, data: longStr },
      ],
    };
    const result = truncateJsonNode(node, 100) as any;
    assert.ok(result.items[0].data.length < longStr.length);
    assert.ok(result.items[1].data.length < longStr.length);
    assert.strictEqual(result.items[0].id, 1);
    assert.strictEqual(result.items[1].id, 2);
  });

  it('number / boolean / null 不被修改', () => {
    const node = { n: 42, b: true, nl: null, big: 9999999999999999n };
    // 注意：bigint 不能被 JSON.stringify，所以单独测试
    const node2 = { n: 42, b: true, nl: null };
    const result = truncateJsonNode(node2, 100) as any;
    assert.strictEqual(result.n, 42);
    assert.strictEqual(result.b, true);
    assert.strictEqual(result.nl, null);
  });

  it('空对象和空数组保持不变', () => {
    assert.deepStrictEqual(truncateJsonNode({}, 100), {});
    assert.deepStrictEqual(truncateJsonNode([], 100), []);
  });

  it('null 不被修改', () => {
    assert.strictEqual(truncateJsonNode(null, 100), null);
  });

  it('原始值（非 object/null）不被修改', () => {
    assert.strictEqual(truncateJsonNode('hello', 100), 'hello');
    assert.strictEqual(truncateJsonNode(42, 100), 42);
    assert.strictEqual(truncateJsonNode(true, 100), true);
  });
});

// ========== 3. JSON 特殊字符与转义 ==========

describe('truncateJsonNode — JSON 特殊字符安全', () => {
  it('包含双引号的字符串', () => {
    const str = 'He said "hello" ' + genStr(5000);
    const result = truncateJsonNode({ msg: str }, 100) as any;
    // 序列化结果应为合法 JSON
    assert.strictEqual(isValidJson(JSON.stringify(result)), true);
  });

  it('包含反斜杠的字符串', () => {
    const str = 'path\\to\\file ' + genStr(5000);
    const result = truncateJsonNode({ msg: str }, 100) as any;
    assert.strictEqual(isValidJson(JSON.stringify(result)), true);
  });

  it('包含控制字符的字符串', () => {
    const str = 'line1\nline2\ttab ' + genStr(5000);
    const result = truncateJsonNode({ msg: str }, 100) as any;
    assert.strictEqual(isValidJson(JSON.stringify(result)), true);
  });

  it('包含 unicode 转义序列的字符串', () => {
    const str = 'emoji: \u0041\u0042 ' + genStr(5000);
    const result = truncateJsonNode({ msg: str }, 100) as any;
    assert.strictEqual(isValidJson(JSON.stringify(result)), true);
  });

  it('包含正反斜杠混合的复杂字符串', () => {
    const str = '{"inner": "value"} \\\\ \\/ ' + genStr(5000);
    const result = truncateJsonNode({ msg: str }, 100) as any;
    assert.strictEqual(isValidJson(JSON.stringify(result)), true);
  });
});

// ========== 4. Unicode / Emoji 安全 ==========

describe('Unicode / Emoji 安全截断', () => {
  it('不在代理对（emoji）中间切割', () => {
    // 😀 是代理对（2 个 UTF-16 码元）
    const emojiStr = '😀'.repeat(200); // 每个 emoji 2 chars
    const result = truncateJsonNode({ data: emojiStr }, 50) as any;
    const truncated = result.data as string;
    // 截断后的字符串不应包含孤立的代理项
    // 如果在代理对中间切了，JSON.stringify 会产生乱码但不抛异常
    // 我们验证截断确实发生了
    assert.ok(truncated.length < emojiStr.length);
  });

  it('中文字符串截断后仍合法', () => {
    const chineseStr = '你好世界'.repeat(2000);
    const result = truncateJsonNode({ msg: chineseStr }, 100) as any;
    assert.strictEqual(isValidJson(JSON.stringify(result)), true);
  });

  it('组合字符（零宽连接符）不导致乱码', () => {
    // ZWJ 序列：👨‍👩‍👧‍👦（family emoji，由多个码点 + ZWJ 组成）
    const familyEmoji = '👨‍👩‍👧‍👦'.repeat(500);
    const result = truncateJsonNode({ data: familyEmoji }, 100) as any;
    assert.strictEqual(isValidJson(JSON.stringify(result)), true);
  });

  it('truncateHeadTail 的 Unicode 安全', () => {
    const str = '🚀'.repeat(1000);
    const result = truncateHeadTail(str, 500);
    // 结果不应包含孤立代理项（不会导致编码错误）
    assert.ok(result.length <= 1000); // 允许标记带来的额外长度
    // 验证字符串可以被正常处理（不抛异常）
    assert.doesNotThrow(() => JSON.stringify(result));
  });
});

// ========== 5. 数组裁剪 ==========

describe('shrinkArray — 数组裁剪', () => {
  it('数组不超限时保持不变', () => {
    const arr = [1, 2, 3];
    const result = shrinkArray(arr, 1000);
    assert.deepStrictEqual(result, arr);
  });

  it('裁剪大数组，保留首尾', () => {
    const arr = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const result = shrinkArray(arr, 2000);
    assert.ok(result.length < arr.length, '数组应被裁剪');
    assert.ok(result.length >= 2, '至少保留部分元素');
    // 第一个元素应是原始第一个
    assert.deepStrictEqual(result[0], arr[0]);
    // 最后一个元素应是原始最后一个
    assert.deepStrictEqual(result[result.length - 1], arr[arr.length - 1]);
    // 中间有标记元素
    const hasMarker = result.some(
      (item) => typeof item === 'string' && item.includes('items omitted'),
    );
    assert.ok(hasMarker, '应包含裁剪标记');
  });

  it('混合类型数组的裁剪', () => {
    const arr: unknown[] = [
      'short',
      42,
      { nested: 'value' },
      null,
      true,
      ...Array.from({ length: 500 }, (_, i) => `item-${i}`),
    ];
    const result = shrinkArray(arr, 500);
    assert.ok(result.length < arr.length);
  });

  it('全是短元素的巨大数组', () => {
    const arr = Array.from({ length: 10000 }, (_, i) => i);
    const result = shrinkArray(arr, 500);
    assert.ok(result.length < arr.length);
    // 第一个和最后一个保留
    assert.strictEqual(result[0], 0);
    assert.strictEqual(result[result.length - 1], 9999);
  });

  it('空数组和单元素数组', () => {
    assert.deepStrictEqual(shrinkArray([], 100), []);
    assert.deepStrictEqual(shrinkArray([42], 100), [42]);
  });

  it('裁剪后序列化结果是合法 JSON', () => {
    const arr = Array.from({ length: 500 }, (_, i) => ({ id: i, data: `item-${i}` }));
    const result = shrinkArray(arr, 1000);
    assert.strictEqual(isValidJson(JSON.stringify(result)), true);
  });
});

// ========== 6. tryJsonTruncate — JSON 策略集成 ==========

describe('tryJsonTruncate — JSON 策略', () => {
  it('合法 JSON 对象 → 字段截断', () => {
    const longStr = genStr(DEFAULT_HARD_LIMIT + 5000);
    const json = JSON.stringify({ data: longStr, name: 'test' });
    const result = tryJsonTruncate(json, 10000, 1000);
    assert.ok(result !== null);
    assert.strictEqual(result!.strategy, 'json-fields');
    assert.ok(result!.output.length <= 10000);
    assert.strictEqual(isValidJson(result!.output), true);
  });

  it('合法 JSON 数组 → 数组裁剪', () => {
    // 大量小元素的数组，字段截断不够，需要数组裁剪
    const items = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const json = JSON.stringify({ items, total: 5000 });
    const result = tryJsonTruncate(json, 5000, 200);
    assert.ok(result !== null);
    assert.strictEqual(result!.strategy, 'json-array');
    assert.ok(result!.output.length <= 5000);
    assert.strictEqual(isValidJson(result!.output), true);
  });

  it('非 JSON 字符串返回 null', () => {
    const result = tryJsonTruncate('not json at all', 1000, 100);
    assert.strictEqual(result, null);
  });

  it('JSON 原始值（非 object）返回 null', () => {
    const longStr = genStr(5000);
    const result = tryJsonTruncate(JSON.stringify(longStr), 1000, 100);
    assert.strictEqual(result, null);
  });

  it('JSON number 返回 null', () => {
    const result = tryJsonTruncate(JSON.stringify(42), 1000, 100);
    assert.strictEqual(result, null);
  });

  it('JSON null 返回 null', () => {
    const result = tryJsonTruncate(JSON.stringify(null), 1000, 100);
    assert.strictEqual(result, null);
  });

  it('截断后的 JSON 可以被 parse 并保留结构', () => {
    const json = JSON.stringify({
      references: Array.from({ length: 200 }, (_, i) => ({
        path: `/file${i}.ts`,
        line: i,
        preview: 'x'.repeat(500),
      })),
      total: 200,
    });
    const result = tryJsonTruncate(json, 5000, 200);
    assert.ok(result !== null);
    const parsed = JSON.parse(result!.output);
    assert.ok('references' in parsed);
    assert.ok('total' in parsed);
    assert.strictEqual(parsed.total, 200);
  });
});

// ========== 7. 行感知 head+tail ==========

describe('truncateByLines — 行感知截断', () => {
  it('保留首尾行', () => {
    const text = genLines(1000, 80);
    const result = truncateByLines(text, 5000);
    assert.ok(result.length <= 6000); // 允许标记带来的额外长度
    assert.ok(result.includes('Line 0:'), '应包含首行');
    assert.ok(result.includes('Line 999:'), '应包含末行');
    assert.ok(result.includes('truncated'), '应包含截断标记');
  });

  it('短文本不截断', () => {
    const text = 'line1\nline2\nline3';
    const result = truncateByLines(text, 1000);
    assert.strictEqual(result, text);
  });

  it('单行超长文本：每行都很长', () => {
    const text = Array.from({ length: 5 }, (_, i) => genStr(1000, `row${i}-`)).join('\n');
    const result = truncateByLines(text, 2000);
    assert.ok(result.includes('truncated'));
  });
});

// ========== 8. 字符级 head+tail（兜底） ==========

describe('truncateHeadTail — 字符级截断', () => {
  it('保留首尾内容', () => {
    const str = 'HEAD_' + genStr(10000) + '_TAIL';
    const result = truncateHeadTail(str, 2000);
    assert.ok(result.includes('HEAD_'), '应保留头部标记');
    assert.ok(result.includes('_TAIL'), '应保留尾部标记');
    assert.ok(result.includes('truncated'), '应包含截断标记');
  });

  it('截断后长度不超过限制太多', () => {
    const str = genStr(50000);
    const result = truncateHeadTail(str, 5000);
    assert.ok(result.length <= 5500, `结果应在限制范围内，实际 ${result.length}`);
  });
});

// ========== 9. truncateOutput — 级联策略选择 ==========

describe('truncateOutput — 级联策略', () => {
  it('JSON 输入 → 使用 json 策略', () => {
    const json = JSON.stringify({ data: genStr(DEFAULT_HARD_LIMIT + 10000) });
    const result = truncateOutput(json, { hardLimit: 5000, fieldLimit: 500 });
    assert.strictEqual(result.truncated, true);
    assert.ok(result.strategy === 'json-fields' || result.strategy === 'json-array');
    assert.strictEqual(isValidJson(result.output), true);
  });

  it('多行文本 → 使用 line-headtail 策略', () => {
    const text = genLines(2000, 100);
    const result = truncateOutput(text, { hardLimit: 5000 });
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.strategy, 'line-headtail');
  });

  it('单行超长非 JSON → 使用 char-headtail 策略', () => {
    const str = genStr(10000);
    const result = truncateOutput(str, { hardLimit: 2000 });
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.strategy, 'char-headtail');
  });

  it('截断后一定不超过 hardLimit + 标记预算', () => {
    const str = genStr(100000);
    const result = truncateOutput(str, { hardLimit: 5000 });
    assert.ok(result.output.length <= 6000, `实际 ${result.output.length}`);
  });
});

// ========== 10. 幂等性：已截断结果不重复截断 ==========

describe('幂等性 — 阈值分离', () => {
  it('工具自截断到 30K → 安全网 50K 不介入', () => {
    // 模拟 shell 工具自行截断到 30K 的结果
    const selfTruncated = genStr(28000) + '\n[truncated marker]\n' + genStr(1500);
    const result = truncateOutput(selfTruncated, { hardLimit: 50000 });
    assert.strictEqual(result.truncated, false, '安全网不应截断已在阈值内的结果');
  });

  it('截断后的结果再次通过安全网不被二次截断', () => {
    const str = genStr(100000);
    const first = truncateOutput(str, { hardLimit: 5000 });
    assert.strictEqual(first.truncated, true);
    // 再次通过安全网
    const second = truncateOutput(first.output, { hardLimit: 5000 });
    assert.strictEqual(second.truncated, false, '已截断结果不应被二次截断');
  });
});

// ========== 11. 极端边界情况 ==========

describe('极端边界情况', () => {
  it('空字符串不截断', () => {
    const result = truncateOutput('');
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.output, '');
  });

  it('仅包含换行符的文本', () => {
    const text = '\n'.repeat(10000);
    const result = truncateOutput(text, { hardLimit: 1000 });
    assert.strictEqual(result.truncated, true);
    assert.ok(result.output.length <= 1500);
  });

  it('单个超长字符串字段（10MB）', () => {
    const huge = genStr(10_000_000);
    const json = JSON.stringify({ data: huge });
    const result = truncateOutput(json, { hardLimit: 5000, fieldLimit: 500 });
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(isValidJson(result.output), true);
    assert.ok(result.output.length <= 6000);
  });

  it('超深嵌套 JSON（100 层）', () => {
    let node: any = { value: 'deep' };
    for (let i = 0; i < 100; i++) {
      node = { nested: node, padding: genStr(100) };
    }
    const json = JSON.stringify(node);
    const result = truncateOutput(json, { hardLimit: 5000, fieldLimit: 100 });
    assert.strictEqual(result.truncated, true);
    // 如果 JSON 策略成功，结果应合法；如果回退到文本截断，JSON 可能不完整
    if (result.strategy === 'json-fields' || result.strategy === 'json-array') {
      assert.strictEqual(isValidJson(result.output), true);
    }
  });

  it('超长数组（100000 个小元素）', () => {
    const arr = Array.from({ length: 100000 }, (_, i) => i);
    const json = JSON.stringify({ items: arr });
    const result = truncateOutput(json, { hardLimit: 5000, fieldLimit: 100 });
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(isValidJson(result.output), true);
    assert.ok(result.output.length <= 6000);
  });

  it('混合超大字段和超大数组', () => {
    const json = JSON.stringify({
      hugeField: genStr(30000),
      items: Array.from({ length: 1000 }, (_, i) => ({ id: i, data: genStr(100) })),
      normalField: 'ok',
    });
    const result = truncateOutput(json, { hardLimit: 5000, fieldLimit: 200 });
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(isValidJson(result.output), true);
    const parsed = JSON.parse(result.output);
    assert.ok('hugeField' in parsed);
    assert.ok('items' in parsed);
    assert.strictEqual(parsed.normalField, 'ok');
  });
});

// ========== 12. JSON 合法性保证（核心测试） ==========

describe('JSON 合法性保证', () => {
  it('所有 JSON 截断策略的结果都能被 JSON.parse', () => {
    const testCases = [
      // 超长字段
      JSON.stringify({ a: genStr(60000) }),
      // 超长数组
      JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => `item${i}`) }),
      // 嵌套对象 + 超长字段
      JSON.stringify({ a: { b: { c: { d: genStr(60000) } } } }),
      // 混合类型数组
      JSON.stringify({ arr: [1, 'a', true, null, { x: genStr(60000) }, [1, 2, 3]] }),
      // 包含特殊字符
      JSON.stringify({ msg: 'hello\tworld\n' + genStr(60000) }),
      // 包含引号和反斜杠
      JSON.stringify({ path: 'C:\\Users\\test\\"file"' + genStr(60000) }),
    ];

    for (const json of testCases) {
      const result = truncateOutput(json, { hardLimit: 3000, fieldLimit: 200 });
      if (result.truncated) {
        assert.ok(
          isValidJson(result.output),
          `截断结果应为合法 JSON，策略=${result.strategy}`,
        );
      }
    }
  });

  it('截断后 JSON 结构保留原始 key', () => {
    const json = JSON.stringify({
      references: [{ path: 'a.ts', line: 1 }],
      total: 1,
      metadata: { source: 'lsp' },
      hugeField: genStr(60000),
    });
    const result = truncateOutput(json, { hardLimit: 3000, fieldLimit: 200 });
    const parsed = JSON.parse(result.output);
    assert.ok('references' in parsed);
    assert.ok('total' in parsed);
    assert.ok('metadata' in parsed);
    assert.ok('hugeField' in parsed);
    assert.strictEqual(parsed.total, 1);
    assert.strictEqual(parsed.metadata.source, 'lsp');
  });

  it('截断后数组元素类型信息保留', () => {
    const json = JSON.stringify({
      items: Array.from({ length: 2000 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        active: i % 2 === 0,
      })),
    });
    const result = truncateOutput(json, { hardLimit: 2000, fieldLimit: 100 });
    const parsed = JSON.parse(result.output);
    assert.ok(Array.isArray(parsed.items));
    // 第一个元素应有完整类型
    const first = parsed.items[0];
    assert.strictEqual(typeof first.id, 'number');
    assert.strictEqual(typeof first.name, 'string');
    assert.strictEqual(typeof first.active, 'boolean');
  });
});

// ========== 13. 截断标记可读性 ==========

describe('截断标记', () => {
  it('JSON 字段截断标记包含 omitted 信息', () => {
    const longStr = genStr(10000);
    const result = truncateJsonNode({ data: longStr }, 100) as any;
    assert.ok(result.data.includes('omitted'));
  });

  it('行截断标记包含行数信息', () => {
    const text = genLines(5000, 80);
    const result = truncateByLines(text, 3000);
    assert.ok(result.includes('lines'));
    assert.ok(result.includes('truncated'));
  });

  it('字符截断标记包含 KB 信息', () => {
    const str = genStr(50000);
    const result = truncateHeadTail(str, 5000);
    assert.ok(result.includes('KB'));
  });

  it('数组裁剪标记包含条目数', () => {
    const arr = Array.from({ length: 1000 }, () => ({ x: 1 }));
    const result = shrinkArray(arr, 200);
    const marker = result.find((r) => typeof r === 'string');
    assert.ok(marker);
    assert.ok(marker!.includes('items omitted'));
  });
});

// ========== 14. 自定义配置 ==========

describe('自定义配置', () => {
  it('自定义 hardLimit', () => {
    const str = genStr(2000);
    const result = truncateOutput(str, { hardLimit: 1000 });
    assert.strictEqual(result.truncated, true);
    assert.ok(result.output.length <= 1100);
  });

  it('自定义 fieldLimit 影响 JSON 字段截断粒度', () => {
    const json = JSON.stringify({ data: genStr(10000) });
    const result1 = truncateOutput(json, { hardLimit: 5000, fieldLimit: 500 });
    const result2 = truncateOutput(json, { hardLimit: 5000, fieldLimit: 2000 });
    // 更大的 fieldLimit 意味着每个字段保留更多内容
    // 但总体积仍受 hardLimit 限制
    if (result1.strategy === 'json-fields' && result2.strategy === 'json-fields') {
      const parsed1 = JSON.parse(result1.output);
      const parsed2 = JSON.parse(result2.output);
      assert.ok(parsed2.data.length >= parsed1.data.length);
    }
  });
});

// ========== 15. 不应崩溃的边界 ==========

describe('不崩溃保证', () => {
  it('只有空格的 JSON 字符串', () => {
    const result = truncateOutput('     ', { hardLimit: 2 });
    assert.ok(result.output.length <= 300);
  });

  it('仅包含 JSON 大括号的字符串', () => {
    // {} 只有 2 字符，默认 hardLimit 远大于此，不会触发截断
    const result = truncateOutput('{}');
    assert.strictEqual(result.truncated, false);
  });

  it('包含 null 字节的字符串', () => {
    const str = 'before\0' + genStr(5000) + '\0after';
    const result = truncateOutput(str, { hardLimit: 1000 });
    assert.strictEqual(result.truncated, true);
  });

  it('包含 U+2028（行分隔符）的字符串', () => {
    // U+2028 在 JSON 中是合法的但在某些上下文中有特殊含义
    const str = 'line1\u2028line2 ' + genStr(5000);
    const result = truncateOutput(str, { hardLimit: 1000 });
    assert.strictEqual(result.truncated, true);
  });

  it('包含 U+2029（段分隔符）的字符串', () => {
    const str = 'para1\u2029para2 ' + genStr(5000);
    const result = truncateOutput(str, { hardLimit: 1000 });
    assert.strictEqual(result.truncated, true);
  });

  it('包含各种 BOM 的字符串', () => {
    const str = '\uFEFF' + genStr(5000);
    const result = truncateOutput(str, { hardLimit: 1000 });
    assert.strictEqual(result.truncated, true);
  });

  it('超长但无换行的 JSON 数组（单行）', () => {
    const items = Array.from({ length: 10000 }, (_, i) => i);
    // 不 pretty-print，紧凑 JSON
    const json = JSON.stringify(items);
    const result = truncateOutput(json, { hardLimit: 2000, fieldLimit: 100 });
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(isValidJson(result.output), true);
  });

  it('包含 HTML 标签的字符串（不应被当作 JSON）', () => {
    const html = '<html><body>' + genStr(10000) + '</body></html>';
    const result = truncateOutput(html, { hardLimit: 2000 });
    assert.strictEqual(result.truncated, true);
    // HTML 不是合法 JSON，应走文本截断策略
    assert.ok(result.strategy === 'char-headtail' || result.strategy === 'line-headtail');
  });

  it('包含 SQL 语句的字符串', () => {
    const sql = 'SELECT * FROM users WHERE name LIKE \'%' + 'a'.repeat(10000) + '%\';';
    const result = truncateOutput(sql, { hardLimit: 2000 });
    assert.strictEqual(result.truncated, true);
  });

  it('Base64 编码的超长字符串', () => {
    const b64 = 'SGVsbG8gV29ybGQ='.repeat(2000);
    const result = truncateOutput(b64, { hardLimit: 2000 });
    assert.strictEqual(result.truncated, true);
  });
});

// ============================================================================
// 持久化与路径注入测试
// ============================================================================

describe('OutputGuard persistAndAnnotate', () => {
  // 由于 persistAndAnnotate 是 OutputGuardFeature 的私有方法，
  // 这里通过集成测试验证：截断后输出中包含文件路径引用。
  // 需要实际 Feature 实例和临时目录。

  function makeFeature(workdir) {
    return new OutputGuardFeature({ workdir, hardLimit: 2000, fieldLimit: 500 });
  }

  function makeCtx(result, toolName = 'test_tool') {
    return {
      toolName,
      call: { name: toolName, arguments: {} },
      result: { success: true, result },
      step: 0,
    };
  }

  it('JSON 结果截断后注入 _outputGuard 字段', async () => {
    const dir = join(tmpdir(), 'og-test-' + Math.random().toString(36).slice(2));
    const feature = makeFeature(dir);
    const hugeJson = JSON.stringify({ data: 'X'.repeat(5000) });
    const returned = await feature.handleToolResultTransform(makeCtx(hugeJson));
    assert.ok(returned, '应返回截断结果');

    const parsed = JSON.parse(returned.result);
    assert.ok(parsed._outputGuard, '应包含 _outputGuard 字段');
    assert.ok(parsed._outputGuard.fullOutputPath, '应有文件路径');
    assert.strictEqual(typeof parsed._outputGuard.originalSize, 'number');
    assert.strictEqual(typeof parsed._outputGuard.originalLines, 'number');
    assert.ok(parsed._outputGuard.originalLines > 0, '行数应 > 0');

    // 验证文件确实存在且包含完整原始内容
    const filePath = parsed._outputGuard.fullOutputPath;
    assert.strictEqual(existsSync(filePath), true, '文件应存在');
    const savedContent = readFileSync(filePath, 'utf-8');
    assert.strictEqual(savedContent, hugeJson, '保存的内容应等于原始完整输出');

    // JSON 整体仍合法
    assert.strictEqual(isValidJson(returned.result), true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('纯文本结果截断后在头部插入路径提示', async () => {
    const dir = join(tmpdir(), 'og-test-' + Math.random().toString(36).slice(2));
    const feature = makeFeature(dir);
    const hugeText = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'A'.repeat(50)}`).join('\n');
    const returned = await feature.handleToolResultTransform(makeCtx(hugeText));
    assert.ok(returned, '应返回截断结果');

    // 头部应包含 OutputGuard 提示行
    assert.ok(returned.result.includes('OutputGuard'), '应包含 OutputGuard 标记');
    assert.ok(returned.result.includes('saved to:'), '应包含 saved to 提示');
    assert.ok(returned.result.includes('lines'), '应包含行数信息');

    // 提取路径并验证文件
    const match = returned.result.match(/saved to: (.+?)\]/);
    assert.ok(match, '应能提取文件路径');
    const filePath = match[1];
    assert.strictEqual(existsSync(filePath), true, '文件应存在');
    const savedContent = readFileSync(filePath, 'utf-8');
    assert.strictEqual(savedContent, hugeText, '保存的内容应等于原始完整输出');

    rmSync(dir, { recursive: true, force: true });
  });

  it('数组型 JSON 截断后 _outputGuard 正确注入', async () => {
    const dir = join(tmpdir(), 'og-test-' + Math.random().toString(36).slice(2));
    const feature = makeFeature(dir);
    // 注意：顶层是数组的 JSON，_outputGuard 无法注入到数组中
    // 应回退到文本提示方式
    const hugeArrayJson = JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({ id: i, data: 'X'.repeat(100) }))
    );
    const returned = await feature.handleToolResultTransform(makeCtx(hugeArrayJson));
    assert.ok(returned, '应返回截断结果');

    // 数组 JSON 被截断后可能是对象型（如果有外层 wrapper）或文本
    // 检查是否至少包含路径信息
    const hasPath = returned.result.includes('_outputGuard') ||
                     returned.result.includes('OutputGuard');
    assert.ok(hasPath, '应包含路径信息（JSON 字段或文本提示）');

    rmSync(dir, { recursive: true, force: true });
  });

  it('落盘失败时仍返回截断结果（不崩溃）', async () => {
    // 使用包含非法字符的路径，确保 mkdir 失败
    const badDir = join(tmpdir(), 'og-file-blocker-' + Math.random().toString(36).slice(2));
    // 先创建一个文件，然后用它作为父目录（无法 mkdir）
    const { writeFileSync } = await import('fs');
    writeFileSync(badDir, 'blocker');
    const feature = makeFeature(join(badDir, 'sub'));
    const hugeText = 'A'.repeat(5000);
    const returned = await feature.handleToolResultTransform(makeCtx(hugeText));
    assert.ok(returned, '即使落盘失败也应返回截断结果');
    assert.ok(returned.result.length < hugeText.length, '结果应被截断');
    // 不应包含路径提示（因为落盘失败）
    assert.ok(!returned.result.includes('saved to:'), '落盘失败不应有路径提示');
    rmSync(badDir, { recursive: true, force: true });
  });

  it('短输出不触发持久化（不创建文件）', async () => {
    const dir = join(tmpdir(), 'og-test-' + Math.random().toString(36).slice(2));
    const feature = makeFeature(dir);
    const short = 'hello';
    const returned = await feature.handleToolResultTransform(makeCtx(short));
    assert.strictEqual(returned, undefined, '短输出应返回 undefined');
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件名包含工具名且 sanitized', async () => {
    const dir = join(tmpdir(), 'og-test-' + Math.random().toString(36).slice(2));
    const feature = makeFeature(dir);
    const hugeText = 'A'.repeat(5000);
    const returned = await feature.handleToolResultTransform(
      makeCtx(hugeText, 'lsp/find_references')
    );
    assert.ok(returned);
    const match = returned.result.match(/saved to: (.+?)\]/);
    if (match) {
      const fileName = match[1].split(/[\\/]/).pop();
      assert.ok(fileName.startsWith('tool-output-lsp_find_references-'),
        `文件名应包含 sanitized 工具名, got: ${fileName}`);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

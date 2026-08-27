import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createReadTool, createEditTool } from '../../src/features/opencode-basic/tools.js';

/**
 * edit 工具的字符归一化匹配（弯引号、Unicode 空白、零宽字符）。
 * 归一化命中视为精确匹配（走 simpleReplacer，不触发 fuzzy 警告）。
 */
describe('edit tool character normalization matching', () => {
  let tmpDir: string;
  let fileSeq = 0;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentdev-edit-norm-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 写入初始内容 → read 建立 dedup → 执行 edit，返回 { result, finalContent } */
  async function editFile(
    initial: string,
    oldString: string,
    newString: string,
    options?: { replaceAll?: boolean },
  ): Promise<{ result: any; finalContent: string }> {
    const filePath = join(tmpDir, `norm-${fileSeq++}.js`);
    writeFileSync(filePath, initial);
    await createReadTool(tmpDir).execute({ filePath }, {} as any);
    const result = await createEditTool(tmpDir).execute(
      { filePath, oldString, newString, replaceAll: options?.replaceAll },
      {} as any,
    ) as any;
    return { result, finalContent: readFileSync(filePath, 'utf-8') };
  }

  it('matches oldString written with ASCII space against NBSP in file', async () => {
    const { result, finalContent } = await editFile(
      'const\u00A0x = 1;\nconst y = 2;\n',
      'const x = 1;',
      'const x = 42;',
    );
    expect(finalContent).toBe('const x = 42;\nconst y = 2;\n');
    // 归一化命中不触发模糊匹配警告
    expect(result.text).not.toContain('fuzzy');
  });

  it('matches oldString written with ASCII space against ideographic space in file', async () => {
    const { finalContent } = await editFile(
      'const\u3000x = 1;\n',
      'const x = 1;',
      'const x = 42;',
    );
    expect(finalContent).toBe('const x = 42;\n');
  });

  it('strips zero-width characters inside matched range without shifting the region', async () => {
    // U+200B 藏在标识符中间：终端零宽不渲染，模型 read 看到的是
    // “constx = 1;”。命中区间必须按原文下标换算，替换后零宽字符
    // 被清除、后续行保持原样（索引不错位）
    const { finalContent } = await editFile(
      'const\u200Bx = 1;\nconst y = 2;\nconst z = 3;\n',
      'constx = 1;',
      'const x = 42;',
    );
    expect(finalContent).toBe('const x = 42;\nconst y = 2;\nconst z = 3;\n');
  });

  it('keeps zero-width characters outside matched range intact', async () => {
    // 前导 \u200B 在命中区间之外：命中起点按原文下标换算（跳过零宽），
    // 前导零宽保留在文件中，区间内的零宽被替换清除
    const { finalContent } = await editFile(
      '\u200Bfoobar tail\n',
      'foobar',
      'NEW',
    );
    expect(finalContent).toBe('\u200BNEW tail\n');
  });

  it('matches when NBSP, zero-width and curly quotes appear together', async () => {
    // 真实粘贴事故形态：等长映射与删除型归一在同一次匹配中协作
    // （NBSP 在 const/s 之间，零宽藏在引号内容中间，弯引号包裹字符串）
    const { finalContent } = await editFile(
      'const\u00A0s = \u201Chel\u200Blo\u201D;\n',
      'const s = "hello";',
      'const s = 42;',
    );
    expect(finalContent).toBe('const s = 42;\n');
  });

  it('matches oldString polluted with zero-width chars against plain file', async () => {
    // 模型侧生成污染：oldString 混入零宽字符（删除后与文件文本对齐），文件是普通文本
    const { finalContent } = await editFile(
      'const value = compute();\n',
      'const value = compute\u200B();',
      'const value = 1;',
    );
    expect(finalContent).toBe('const value = 1;\n');
  });

  it('matches curly quotes in oldString against straight quotes in file', async () => {
    // 归一化是双侧的：模型复制了排版文本（弯引号），文件是直引号
    const { finalContent } = await editFile(
      'const s = "hello";\n',
      'const s = \u201Chello\u201D;',
      'const s = 42;',
    );
    expect(finalContent).toBe('const s = 42;\n');
  });

  it('fails safely when normalized match is non-unique in file', async () => {
    // 两处相同 NBSP 变体：归一化对位到原文形态后非唯一，必须报错而非挑一处吞掉
    await expect(editFile(
      'let a = foo\u00A0bar;\nlet b = foo\u00A0bar;\n',
      'foo bar',
      'REPLACED',
    )).rejects.toThrow(/multiple matches/i);
  });

  it('rejects oldString consisting only of zero-width characters', async () => {
    // 归一后为空串：无有效匹配内容，不得产生越界或空区间命中
    await expect(editFile('hello world\n', '\u200B\u200D', 'x')).rejects.toThrow(
      /Could not find oldString/,
    );
  });

  it('replaces all normalized occurrences with replaceAll', async () => {
    // replaceAll 语义：对位到的原文形态（NBSP 版本）全文替换
    const { finalContent } = await editFile(
      'a foo\u00A0bar\nb foo\u00A0bar\n',
      'foo bar',
      'X',
      { replaceAll: true },
    );
    expect(finalContent).toBe('a X\nb X\n');
  });

  it('still matches curly quotes in file against straight quotes in oldString', async () => {
    const { finalContent } = await editFile(
      'const s = \u201Chello\u201D;\n',
      'const s = "hello";',
      'const s = 42;',
    );
    expect(finalContent).toBe('const s = 42;\n');
  });

  it('prefers exact match over normalization when both exist', async () => {
    // 文件同时含 ASCII 空格与 NBSP 两个候选：精确命中优先，归一化不劫持
    const { finalContent } = await editFile(
      'let a = foo bar;\nlet b = foo\u00A0bar;\n',
      'foo bar',
      'REPLACED',
    );
    expect(finalContent).toBe('let a = REPLACED;\nlet b = foo\u00A0bar;\n');
  });

  it('reports not-found when no normalized candidate exists either', async () => {
    await expect(editFile('const x = 1;\n', 'nothing matches here', 'z')).rejects.toThrow(
      /Could not find oldString/,
    );
  });
});

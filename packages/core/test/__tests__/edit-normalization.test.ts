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

/**
 * blockAnchorReplacer 的中间行相似度门槛。
 * 首尾行锚定只保证定位，中间行平均相似度不足时必须拒绝：
 * 否则凭锚点整块替换会把与 oldString 无关的内容吞掉（结构性损伤）。
 */
describe('edit tool block anchor similarity guard', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentdev-edit-block-anchor-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function editFile(
    fileName: string,
    initial: string,
    oldString: string,
    newString: string,
  ): Promise<{ result: any; finalContent: string }> {
    const filePath = join(tmpDir, fileName);
    writeFileSync(filePath, initial);
    await createReadTool(tmpDir).execute({ filePath }, {} as any);
    const result = await createEditTool(tmpDir).execute(
      { filePath, oldString, newString },
      {} as any,
    ) as any;
    return { result, finalContent: readFileSync(filePath, 'utf-8') };
  }

  it('rejects a unique candidate whose intermediate lines drift away entirely', async () => {
    // 损伤形态（真实会话模式）：首尾行在文件中锚定唯一，但中间行内容与
    // oldString 完全无关——旧实现无条件整块替换，把不相关的行吞掉
    const initial = [
      'function onCall() {',
      '  a();',
      '  bb();',
      '  ccc();',
      '}',
    ].join('\n') + '\n';
    const oldString = [
      'function onCall() {',
      '  functionOne(argumentOne, argumentTwo);',
      '  functionTwo(argumentThree);',
      '  functionThree(argumentFour, argumentFive, argumentSix);',
      '}',
    ].join('\n');

    await expect(
      editFile('guard-reject.js', initial, oldString, 'REPLACED'),
    ).rejects.toThrow(/Could not find oldString/);

    // 拒绝后文件必须原样保留，不得有部分写入
    expect(readFileSync(join(tmpDir, 'guard-reject.js'), 'utf-8')).toBe(initial);
  });

  it('still rescues a block whose intermediate lines differ only slightly', async () => {
    // 挽救能力保留：中间行仅一处小笔误，平均相似度远超门槛，应模糊命中
    const initial = [
      'async save() {',
      '  const data = await this.#loadAll();',
      '  await persist(data);',
      '}',
    ].join('\n') + '\n';
    const oldString = [
      'async save() {',
      '  const data = await this.#loadAlll();',
      '  await persist(data);',
      '}',
    ].join('\n');
    const newString = [
      'async save() {',
      '  const data = await this.#loadAll();',
      '  await persist(data);',
      '}',
    ].join('\n');

    const { result, finalContent } = await editFile('guard-rescue.js', initial, oldString, newString);

    expect(result.text).toContain('fuzzy');
    expect(finalContent).toBe(initial);
  });
});

/**
 * 模糊替换器加固（源自真实会话事故的回归测试）：
 * - blockAnchorReplacer 早退 bug：累计相似度过门槛即 break，后续行不再检查，
 *   "第一中间行相同 + 其余全错"的块骗过 0.3 门槛被整块替换。
 * - 门槛 0.3 → 0.8：中间行整体高度一致才放行。
 * - 块长守卫：实际块与 oldString 行数差异过大 = 锚点定位到错误块，
 *   旧行为会把不相干的原文件行整块吞掉（20 行 oldString 吞 7 行块事故）。
 * - 缩进敏感语言（Python/YAML）禁用跨行模糊替换：宽容匹配 + newString
 *   原样写入 = 缩进即语法语言的破坏配方。
 * - fuzzy 命中回传 matchedText；not_found 附最接近候选行。
 */
describe('edit tool fuzzy replacer hardening', () => {
  let tmpDir: string;
  let fileSeq = 0;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentdev-edit-fuzzy-hard-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function editFile(
    initial: string,
    oldString: string,
    newString: string,
    fileName = 'hard.js',
  ): Promise<{ result: any; finalContent: string }> {
    const filePath = join(tmpDir, `${fileSeq++}-${fileName}`);
    writeFileSync(filePath, initial);
    await createReadTool(tmpDir).execute({ filePath }, {} as any);
    const result = await createEditTool(tmpDir).execute(
      { filePath, oldString, newString },
      {} as any,
    ) as any;
    return { result, finalContent: readFileSync(filePath, 'utf-8') };
  }

  it('rejects a block whose first middle line matches but the rest drift away (early-break fix)', async () => {
    // 5 行块、3 个中间行：第一个中间行完全相同，后两个完全无关。
    // 旧实现：累计 1.0/3 = 0.33 ≥ 0.3 早退 → 整块替换（事故形态）；
    // 新实现：完整平均 0.33 < 0.8 → 拒绝
    const initial = [
      'function onCall() {',
      '  keepExactLine();',
      '  somethingUnrelated();',
      '  anotherUnrelated();',
      '}',
    ].join('\n') + '\n';
    const oldString = [
      'function onCall() {',
      '  keepExactLine();',
      '  totallyDifferentOne();',
      '  totallyDifferentTwo();',
      '}',
    ].join('\n');

    await expect(editFile(initial, oldString, 'REPLACED')).rejects.toThrow(
      /Could not find oldString/,
    );
    expect(readFileSync(join(tmpDir, `0-hard.js`), 'utf-8')).toBe(initial);
  });

  it('rejects intermediate similarity between the old and new threshold (0.3..0.8)', async () => {
    // 两个中间行相似度约 0.71：旧门槛 0.3 放行，新门槛 0.8 拒绝
    const initial = [
      'function a() {',
      '  abcdefghij();',
      '  klmnopqrst();',
      '}',
    ].join('\n') + '\n';
    const oldString = [
      'function a() {',
      '  abcdefXXXX();',
      '  klmnopXXXX();',
      '}',
    ].join('\n');

    await expect(editFile(initial, oldString, 'REPLACED')).rejects.toThrow(
      /Could not find oldString/,
    );
  });

  it('rejects an anchored block far longer than oldString (span guard)', async () => {
    // 3 行 oldString 锚定到 7 行实际块：中间行相似度满分，但块长差异 4 > 容差 2，
    // 旧行为整块吞掉 exactMiddle + extra1..4（rerun_v5_isolation.py 字典事故形态）
    const initial = [
      'anchorStart',
      'exactMiddle',
      'extra1',
      'extra2',
      'extra3',
      'extra4',
      'anchorEnd',
    ].join('\n') + '\n';
    const oldString = ['anchorStart', 'exactMiddle', 'anchorEnd'].join('\n');

    await expect(editFile(initial, oldString, 'REPLACED')).rejects.toThrow(
      /Could not find oldString/,
    );
    expect(readFileSync(join(tmpDir, `2-hard.js`), 'utf-8')).toBe(initial);
  });

  it('skips over-length candidates in the multi-candidate path (span guard)', async () => {
    // 两个锚点候选：短块中间行不相似、长块中间行满分但块长超容差。
    // 守卫必须把长块剔除，不允许它凭相似度胜出
    const initial = [
      'head',
      'WRONG',
      'tail',
      'head',
      'mid',
      'x1',
      'x2',
      'x3',
      'x4',
      'tail',
    ].join('\n') + '\n';
    const oldString = ['head', 'mid', 'tail'].join('\n');

    await expect(editFile(initial, oldString, 'REPLACED')).rejects.toThrow(
      /Could not find oldString/,
    );
  });

  it('still rescues a well-fitting block after hardening (regression)', async () => {
    // 加固不误伤：锚点唯一、块长一致、中间行仅零星笔误 → 仍模糊命中
    const initial = [
      'async save() {',
      '  const data = await this.load();',
      '  await persist(data);',
      '  return data;',
      '}',
    ].join('\n') + '\n';
    const oldString = [
      'async save() {',
      '  const data = await this.loadd();',
      '  await persist(data);',
      '  return data;',
      '}',
    ].join('\n');
    const newString = initial.trimEnd();

    const { result } = await editFile(initial, oldString, newString);
    expect(result.text).toContain('fuzzy');
  });

  it('disables cross-line fuzzy matching for Python files', async () => {
    // 同一内容：.js 上 lineTrimmedReplacer 挽救缩进差异；.py 上必须显式失败
    const initialJs = 'function main() {\n  alpha();\n  beta();\n}\n';
    const initialPy = 'def main():\n    alpha()\n    beta()\n';
    const oldJs = 'function main() {\nalpha();\nbeta();\n}';
    const oldPy = 'def main():\nalpha()\nbeta()';
    const newJs = 'function main() {\n  alpha();\n  beta();\n}';
    const newPy = 'def main():\n    alpha()\n    beta()';

    const { result, finalContent } = await editFile(initialJs, oldJs, newJs, 'a.js');
    expect(result.text).toContain('fuzzy');
    expect(finalContent).toBe(initialJs);

    await expect(editFile(initialPy, oldPy, newPy, 'b.py')).rejects.toThrow(
      /Could not find oldString/,
    );
    expect(readFileSync(join(tmpDir, '6-b.py'), 'utf-8')).toBe(initialPy);
  });

  it('keeps character-level normalization for Python files (curly quotes)', async () => {
    // 禁用的是跨行模糊替换器，findActualString 字符级归一不受影响
    const { result, finalContent } = await editFile(
      's = "hello";\n',
      's = \u201Chello\u201D;',
      's = "world";',
      'c.py',
    );
    const parsed = JSON.parse(result.text);
    expect(parsed.message).toBe('Edit applied successfully');
    expect(finalContent).toBe('s = "world";\n');
  });

  it('returns matchedText on fuzzy hits so the model can self-verify', async () => {
    // 模糊命中时模型可见的 result 必须包含文件里实际匹配到的文本
    // （diff 只在 display 通道，模型不可见）
    const { result } = await editFile(
      'function main() {\n  alpha();\n  beta();\n}\n',
      'function main() {\nalpha();\nbeta();\n}',
      'function main() {\n  alpha();\n  beta();\n}',
      'd.js',
    );
    const parsed = JSON.parse(result.text);
    expect(parsed.matchedText).toBe('function main() {\n  alpha();\n  beta();\n}');
  });

  it('does not leak matchedText on exact matches', async () => {
    const { result } = await editFile('const x = 1;\n', 'const x = 1;', 'const x = 2;', 'e.js');
    const parsed = JSON.parse(result.text);
    expect(parsed.matchedText).toBeUndefined();
    expect(parsed.message).toBe('Edit applied successfully');
  });

  it('includes closest candidate line hints in the not-found error', async () => {
    // 真实事故形态：模型凭记忆把 ra_groups 记成 rag5_groups → 精确失败。
    // 错误信息必须给出文件里最接近的行，避免模型盲试或降级 sed 手术
    await expect(
      editFile('ra_groups = {}\nra_groups["k"] = 1\n', 'rag5_groups = {}', 'REPLACED', 'f.py'),
    ).rejects.toThrow(/line 1.*ra_groups = \{\}/);
  });
});

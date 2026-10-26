/**
 * skills 多目录发现与同名去重。
 *
 * 回归背景：deduplicateSkills 曾用 `name (1)` 后缀，产物不满足 capability
 * 命令名约束（CAPABILITY_NAME_PATTERN），SkillFeature 注册 slash 命令时
 * register 抛错并炸掉 runtime 启动（真实事故：.agentdev/skills 符号链接与
 * .codex/skills 实体重复发现同一技能）。此文件锁定三条不变量：
 * 1. 去重产物始终是合法命令名；
 * 2. 同一 SKILL.md 实体（符号链接/重复目录）只保留一份；
 * 3. 改名产物与既有技能撞名时继续递增，结果唯一。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverMulti } from '../src/skills/loader.js';
import { CAPABILITY_NAME_PATTERN } from '../src/core/capability.js';

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `skills-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 在 dir/<dirName>/SKILL.md 写一个 frontmatter name 为 frontName 的技能。 */
function writeSkill(dir: string, dirName: string, frontName: string): void {
  const skillDir = join(dir, dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${frontName}\ndescription: ${frontName} skill\n---\nbody`
  );
}

describe('discoverMulti 同名去重', () => {
  it('跨目录同名技能：第二个改名为合法命令名（-N），原名保留', async () => {
    const dirA = join(tempDir, 'a');
    const dirB = join(tempDir, 'b');
    writeSkill(dirA, 'dup', 'dup');
    writeSkill(dirB, 'dup', 'dup');

    const skills = await discoverMulti({
      baseDir: tempDir,
      scanAgentdevDir: false,
      extraDirs: [dirA, dirB],
    });

    expect(skills.map((s) => s.name).sort()).toEqual(['dup', 'dup-1']);
    for (const s of skills) {
      expect(CAPABILITY_NAME_PATTERN.test(s.name)).toBe(true);
    }
  });

  it('符号链接与实体指向同一技能：只保留先发现的一份，名字不变', async () => {
    const realRoot = join(tempDir, 'real-skills');
    const linkRoot = join(tempDir, 'link-skills');
    writeSkill(realRoot, 'stock-investigation', 'stock-investigation');
    mkdirSync(linkRoot, { recursive: true });
    symlinkSync(
      join(realRoot, 'stock-investigation'),
      join(linkRoot, 'stock-investigation')
    );

    const skills = await discoverMulti({
      baseDir: tempDir,
      scanAgentdevDir: false,
      extraDirs: [linkRoot, realRoot],
    });

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('stock-investigation');
    // 保留先发现的入口（extraDirs 数组顺序）：链接路径，而非被去重的实体
    expect(skills[0].path.startsWith(linkRoot)).toBe(true);
  });

  it('改名产物与既有技能撞名时继续递增，结果唯一且全部合法', async () => {
    const d1 = join(tempDir, 'd1');
    const d2 = join(tempDir, 'd2');
    const d3 = join(tempDir, 'd3');
    // 目录扫描顺序 = extraDirs 数组顺序，单目录单技能，顺序完全确定
    writeSkill(d1, 'foo', 'foo');      // 保留 foo
    writeSkill(d2, 'foo', 'foo');      // 改名 foo-1（未撞）
    writeSkill(d3, 'foo-1', 'foo-1');  // 真名 foo-1 已被占用 → foo-1-1

    const skills = await discoverMulti({
      baseDir: tempDir,
      scanAgentdevDir: false,
      extraDirs: [d1, d2, d3],
    });

    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['foo', 'foo-1', 'foo-1-1']);
    expect(new Set(names).size).toBe(3);
    for (const s of skills) {
      expect(CAPABILITY_NAME_PATTERN.test(s.name)).toBe(true);
    }
  });
});

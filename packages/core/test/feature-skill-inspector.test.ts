/**
 * Feature 自带 skills 的 inspector 上报契约。
 *
 * 背景：skillCount 是宿主面板推导「该 feature 具备技能能力」的依据，skills[]
 * 则是面板渲染技能卡片、经 resource.fetch 读取 SKILL.md 所需的元数据。两者
 * 的依赖不同——skills[] 条目必须带 rootId 才能拼出 /res/ 地址，rootId 只在
 * withViewer() 注册资源根时产生；skillCount 不依赖任何地址。
 *
 * 断言：
 * 1. 无 viewer（未注册资源根）时，skillCount 仍反映真实发现数量，skills[] 为空
 *    ——否则无 viewer 的宿主会连「有技能」都看不到（回归风险点）；
 * 2. 资源根已注册时，skills[] 带 rootId 与相对包根的 posix 路径（不是绝对路径、
 *    不用反斜杠），面板据此拼 URL；
 * 3. 资源根注册以包根为边界：技能的 realpath 若逃出包根则不上报（面板不生成
 *    指向根外的链接，与本进程 handler 的 forbidden 判定同源）。
 *
 * 关于资源根注入：rootId 由 withViewer() 分配并写入实例私有表，这里直接向该表
 * 写入固定 rootId——测试要验证的是「根已注册」之后的上报形状，起真实 Viewer 会
 * 把用例变成传输层测试，偏离目标。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BasicAgent } from '../src/agents/index.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

class MockLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'ok' };
  }
}

function writeSkill(packageDir: string, dirName: string): void {
  // 框架按 dirname(source)/skills 发现，这里与 source 同放在 dist/ 下，
  // 与本地 feature（dist/<name>/src/index.js + 同级 skills/）同构。
  const dir = join(packageDir, 'dist', 'skills', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${dirName}\ndescription: ${dirName} skill\n---\nbody\n`,
    'utf-8',
  );
}

/** 伪造一个「包的 dist 内某个 feature 模块」：source 指向包内的 js 文件 */
function makeFeaturePackage(root: string, name: string) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: `${name}-pkg`, version: '0.0.0' }), 'utf-8');
  const sourceFile = join(root, 'dist', 'index.js');
  writeFileSync(sourceFile, '// feature module\n', 'utf-8');
  return {
    name,
    source: sourceFile.replace(/\\/g, '/'),
    getTools: () => [],
  };
}

describe('feature skills inspector 上报', () => {
  let tmpRoot: string;
  let withSkills: ReturnType<typeof makeFeaturePackage>;
  let withoutSkillsDir: ReturnType<typeof makeFeaturePackage>;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'feature-skill-inspector-'));
    const pkgA = join(tmpRoot, 'pkg-a');
    withSkills = makeFeaturePackage(pkgA, 'skillful');
    writeSkill(pkgA, 'alpha');
    writeSkill(pkgA, 'beta');

    // source 同级没有 skills/ 目录：该 feature 不应出现在技能归属里
    const pkgB = join(tmpRoot, 'pkg-b');
    withoutSkillsDir = makeFeaturePackage(pkgB, 'plain');
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function inspectorFor(configureRoots?: (agent: any) => void) {
    const agent = new BasicAgent({ llm: new MockLLM(), name: `skill-inspector-${Math.random().toString(36).slice(2)}` });
    agent.use(withSkills as any);
    agent.use(withoutSkillsDir as any);
    configureRoots?.(agent);
    return agent;
  }

  function featuresOf(agent: any): any[] {
    return (agent as any).buildHookInspectorSnapshot().features;
  }

  it('无 viewer 时仍上报真实 skillCount，skills[] 为空', async () => {
    const agent = inspectorFor();
    await agent.ensureFeatureTools();

    const features = featuresOf(agent);
    const skillful = features.find(f => f.name === 'skillful');
    expect(skillful.skillCount).toBe(2);
    expect(skillful.skills).toEqual([]);

    const plain = features.find(f => f.name === 'plain');
    expect(plain.skillCount).toBe(0);
    expect(plain.skills).toEqual([]);
  });

  it('资源根已注册时按包根相对路径上报，带 rootId', async () => {
    const agent = inspectorFor((a) => {
      // 对应 withViewer() 为包根分配的 rootId
      a.featureResourceRootIds.set('skillful', 3);
    });
    await agent.ensureFeatureTools();

    const skillful = featuresOf(agent).find(f => f.name === 'skillful');
    expect(skillful.skills).toEqual([
      { name: 'alpha', description: 'alpha skill', root: 3, path: 'dist/skills/alpha/SKILL.md' },
      { name: 'beta', description: 'beta skill', root: 3, path: 'dist/skills/beta/SKILL.md' },
    ]);
    expect(skillful.skillCount).toBe(2);
    for (const skill of skillful.skills) {
      expect(skill.path).not.toMatch(/^[A-Za-z]:/); // 不是绝对路径
      expect(skill.path).not.toContain('\\');      // 统一 posix 分隔符
    }
  });

  it('未注册资源根的 feature 不上报 skills[]（无法拼出可读地址）', async () => {
    const agent = inspectorFor((a) => {
      // 只给 plain 一个根，skillful 有技能但无根
      a.featureResourceRootIds.set('plain', 0);
    });
    await agent.ensureFeatureTools();

    const features = featuresOf(agent);
    const skillful = features.find(f => f.name === 'skillful');
    expect(skillful.skills).toEqual([]);
    expect(skillful.skillCount).toBe(2); // 数量事实不因缺地址而丢失
  });

  it('技能的 realpath 逃出包根时不上报该条（包根是授权边界）', async () => {
    // 包内 skills/escape 是指向包外的目录链接。框架用 realpath 判定归属：
    // 逃出包根的技能不能进 skills[]——面板会用 root + path 拼 /res/ 地址，
    // 若上报了，等于把包外路径挂到根内地址下（handler 侧会 403，但面板会
    // 显示一个永远读不出来的技能卡片）。
    const pkgC = join(tmpRoot, 'pkg-c');
    const linked = makeFeaturePackage(pkgC, 'linky');
    const outsideDir = join(tmpRoot, 'outside-skill');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'SKILL.md'), '---\nname: escaped\ndescription: escaped skill\n---\nbody\n', 'utf-8');
    mkdirSync(join(pkgC, 'dist', 'skills'), { recursive: true });
    symlinkSync(outsideDir, join(pkgC, 'dist', 'skills', 'escaped'), 'junction');
    writeSkill(pkgC, 'inside'); // 包内正常的一条，用作对照

    const agent = new BasicAgent({ llm: new MockLLM(), name: `skill-escape-${Math.random().toString(36).slice(2)}` });
    agent.use(linked as any);
    (agent as any).featureResourceRootIds.set('linky', 0);
    await agent.ensureFeatureTools();

    const linky = featuresOf(agent).find(f => f.name === 'linky');
    expect(linky.skills.map((s: any) => s.name)).toEqual(['inside']);
    for (const skill of linky.skills) {
      expect(skill.path.startsWith('dist/skills/inside')).toBe(true);
      expect(skill.path).not.toContain('escaped');
    }
  });
});

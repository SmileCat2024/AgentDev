import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import {
  probeStateRoundtrip,
  probeCaptureRestoreStatus,
  type StateRoundtripProbe,
} from './helpers/feature-state-roundtrip.js';
import { captureFeatureSnapshots } from '../core/checkpoint.js';
import type { AgentFeature } from '../core/feature.js';

// ========== 内置 feature 装配 ==========

import { AudioFeedbackFeature } from '../features/audio-feedback/index.js';
import { ExampleFeature } from '../features/example-feature/index.js';
import { FileHistoryFeature } from '../features/file-history/index.js';
import { HandoffSeedFeature } from '../features/handoff-seed/index.js';
import { LspFeature } from '../features/lsp/index.js';
import { MemoryFeature } from '../features/memory/index.js';
import { OpencodeBasicFeature } from '../features/opencode-basic/index.js';
import { OutputGuardFeature } from '../features/output-guard/index.js';
import { SubAgentFeature } from '../features/subagent/index.js';
import { TodoFeature } from '../features/todo/index.js';
import { TTSFeature } from '../features/tts/index.js';
import { VisualFeature } from '../features/visual/index.js';

import { AuditFeature } from '../features/audit/index.js';
import { MCPFeature } from '../features/mcp/index.js';
import { PluginCompatFeature } from '../features/plugin-compat/index.js';
import { ShellFeature } from '../features/shell/index.js';
import { SkillFeature } from '../features/skill/index.js';
import { UserInputFeature } from '../features/user-input/index.js';
import { WebSearchFeature } from '../features/websearch/index.js';

/**
 * 内置 feature 状态契约摸底登记表（B 热载前置，2026-08）。
 *
 * - roundtrip（含 equal）: 回滚/热载后状态可完整还原
 * - roundtrip（lsp 惰性）: capture 记录 activeServerIds，restore 是 no-op
 *   （服务器按需重启）——热载后内存服务器连接丢失，功能惰性自愈
 * - no-state: 未实现状态契约，热载丢内存状态（登记为已知，改进时需更新此表）
 *
 * 该表是「会话不丢」承诺的成色清单：B 工作项（reloadFeature）的验收
 * 应基于此表——status 非 roundtrip 的 feature 热载时状态丢失为已知行为。
 */
const ROUNDTRIP_FACTORIES: Record<string, () => AgentFeature> = {
  'audio-feedback': () => new AudioFeedbackFeature(),
  'example-feature': () => new ExampleFeature(),
  'file-history': () => new FileHistoryFeature(),
  'handoff-seed': () => new HandoffSeedFeature({ handoff: {} }),
  lsp: () => new LspFeature(),
  memory: () => new MemoryFeature(),
  'opencode-basic': () => new OpencodeBasicFeature(),
  'output-guard': () => new OutputGuardFeature(),
  subagent: () => new SubAgentFeature(),
  todo: () => new TodoFeature(),
  tts: () => new TTSFeature(),
  visual: () => new VisualFeature(),
};

const NO_STATE_FACTORIES: Record<string, () => AgentFeature> = {
  audit: () => new AuditFeature(),
  mcp: () => new MCPFeature(),
  'plugin-compat': () => new PluginCompatFeature(),
  shell: () => new ShellFeature(),
  skill: () => new SkillFeature(),
  'user-input': () => new UserInputFeature(),
  websearch: () => new WebSearchFeature(),
};

// ========== 各 feature 的确定性状态注入（非默认值） ==========

type Mutate = (feature: AgentFeature) => void | Promise<void>;

/**
 * 往返全等期望登记：
 * lsp 为 false 是设计内行为——captureState 记录 activeServerIds，
 * restoreState 是惰性 no-op（服务器按需重启，不重建连接）。
 * 此处固化该事实，防止被误判为回归；其余 feature 期望全等。
 */
const EXPECTED_ROUNDTRIP_EQUAL: Record<string, boolean> = {
  lsp: false,
};

const MUTATIONS: Record<string, Mutate> = {
  'audio-feedback': feature => {
    const runtime = (feature as unknown as { runtime: Record<string, unknown> }).runtime;
    runtime.enabled = false;
    runtime.volume = 0.5;
    runtime.playCount = 7;
    runtime.activeMode = 'play-feedback';
  },
  'example-feature': feature => {
    const runtime = (feature as unknown as { runtime: Record<string, unknown> }).runtime;
    runtime.enabled = false;
    runtime.counter = 3;
    runtime.lastInput = 'hello';
    runtime.notes = ['n1', 'n2'];
  },
  'file-history': feature => {
    (feature as unknown as { state: unknown }).state = {
      snapshots: [],
      trackedFiles: ['/w/src/a.ts', '/w/src/b.ts'],
      snapshotCounter: 2,
      sessionId: 'session-x',
      workspaceDir: '/w',
    };
  },
  'handoff-seed': feature => {
    (feature as unknown as { injected: boolean }).injected = true;
  },
  lsp: feature => {
    (feature as unknown as { clients: Map<string, unknown> }).clients = new Map([
      ['typescript', { server: 'mock' }],
    ]);
  },
  memory: feature => {
    (feature as unknown as { _injected: boolean })._injected = true;
  },
  'opencode-basic': feature => {
    (feature as unknown as { readFiles: Set<string> }).readFiles = new Set([
      '/w/a.ts',
      '/w/b.ts',
    ]);
  },
  'output-guard': feature => {
    (feature as unknown as { truncateCount: number }).truncateCount = 4;
  },
  todo: feature => {
    const f = feature as unknown as {
      counter: number;
      reminderContent: string;
      consecutiveNoTodoTurns: number;
      reminderInjected: boolean;
    };
    f.counter = 5;
    f.reminderContent = 'reminder-x';
    f.consecutiveNoTodoTurns = 2;
    f.reminderInjected = true;
  },
  tts: feature => {
    (feature as unknown as { state: Record<string, unknown> }).state = {
      enabled: false,
      lastUtteranceId: 'utt-9',
      totalUtterances: 12,
    };
  },
  visual: feature => {
    const f = feature as unknown as {
      _visualEnabled: boolean;
      injectionState: {
        isFirstInjection: boolean;
        lastInjectedWindows: Map<string, unknown>;
        lastInjectedAnalyses: Map<string, string>;
        focusHistory: string[];
        lastForegroundHwnd: string | null;
      };
    };
    f._visualEnabled = false;
    f.injectionState.isFirstInjection = false;
    f.injectionState.lastInjectedWindows = new Map([
      ['win-1', { title: 'Editor', status: 'ok', processPath: '/e.exe', isForeground: true }],
    ]);
    f.injectionState.lastInjectedAnalyses = new Map([['win-1', 'analysis text']]);
    f.injectionState.focusHistory = ['win-1', 'win-2'];
    f.injectionState.lastForegroundHwnd = 'hwnd-7';
  },
};

// ========== 测试 ==========

describe('feature state roundtrip (B 前置摸底)', () => {
  describe('roundtrip feature：capture → 序列化 → restore → 二次 capture 全等', () => {
    for (const [name, factory] of Object.entries(ROUNDTRIP_FACTORIES)) {
      it(`${name}: 往返保真`, async () => {
        const probe: StateRoundtripProbe = await probeStateRoundtrip(
          factory,
          MUTATIONS[name],
        );
        expect(probe.status).toBe('roundtrip');
        expect(probe.roundtripEqual).toBe(EXPECTED_ROUNDTRIP_EQUAL[name] ?? true);
      });
    }
  });

  describe('no-state feature：显式登记（热载丢状态为已知行为）', () => {
    for (const [name, factory] of Object.entries(NO_STATE_FACTORIES)) {
      it(`${name}: 未实现状态契约`, () => {
        expect(probeCaptureRestoreStatus(factory())).toBe('no-state');
      });
    }

    it('登记表覆盖全部内置 feature（新增 feature 必须登记状态契约）', async () => {
      const { readdir } = await import('fs/promises');
      const { resolve } = await import('path');
      const dirs = await readdir(resolve(__dirname, '../features'));
      // 只统计真正有实现的 feature 目录（排除空目录/纯类型目录）
      const featureDirs = dirs.filter(
        d =>
          !d.includes('.') &&
          readdirSync(resolve(__dirname, '../features', d)).some(f => f === 'index.ts'),
      );
      const registered = new Set([
        ...Object.keys(ROUNDTRIP_FACTORIES),
        ...Object.keys(NO_STATE_FACTORIES),
      ]);
      const missing = featureDirs.filter(d => !registered.has(d));
      expect(missing).toEqual([]);
    });
  });

  describe('框架消费路径镜像（checkpoint.ts）', () => {
    it('captureFeatureSnapshots 只采集 roundtrip feature', () => {
      const features = new Map<string, AgentFeature>();
      features.set('example-feature', new ExampleFeature());
      features.set('shell', new ShellFeature());

      const captured = captureFeatureSnapshots(features);
      expect(captured.map(c => c.featureName)).toEqual(['example-feature']);
    });
  });

  describe('快照字段名契约（不乱命名）', () => {
    it('各 feature captureState 顶层字段稳定', async () => {
      const cases: Array<[string, string[]]> = [
        ['example-feature', ['counter', 'enabled', 'lastInput', 'notes']],
        ['memory', ['injected']],
        ['handoff-seed', ['injected']],
        ['output-guard', ['truncateCount']],
        ['tts', ['enabled', 'lastUtteranceId', 'totalUtterances']],
        ['file-history', [
          'sessionId',
          'snapshotCounter',
          'snapshots',
          'trackedFiles',
          'workspaceDir',
        ]],
      ];
      for (const [name, fields] of cases) {
        const probe = await probeStateRoundtrip(
          ROUNDTRIP_FACTORIES[name],
          MUTATIONS[name],
        );
        expect(probe.capturedFields).toEqual(fields);
      }
    });
  });
});

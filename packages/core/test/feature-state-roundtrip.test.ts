import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import {
  probeStateRoundtrip,
  probeCaptureRestoreStatus,
  type StateRoundtripProbe,
} from './helpers/feature-state-roundtrip.js';
import { captureFeatureSnapshots } from '../src/core/checkpoint.js';
import type { AgentFeature } from '../src/core/feature.js';

// ========== 内置 feature 装配（core 白名单，010 拆分后） ==========

import { ExampleFeature } from '../src/features/example-feature/index.js';
import { FileHistoryFeature } from '../src/features/file-history/index.js';
import { HandoffSeedFeature } from '../src/features/handoff-seed/index.js';
import { LspFeature } from '../src/features/lsp/index.js';
import { OpencodeBasicFeature } from '../src/features/opencode-basic/index.js';
import { OutputGuardFeature } from '../src/features/output-guard/index.js';
import { SubAgentFeature } from '../src/features/subagent/index.js';
import { TodoFeature } from '../src/features/todo/index.js';
import { SkillFeature } from '../src/features/skill/index.js';
import { UserInputFeature } from '../src/features/user-input/index.js';

/**
 * 内置 feature 状态契约摸底登记表（B 热载前置，2026-08）。
 *
 * 010 包拆分后本表只登记 @agentdevjs/core 白名单 feature；
 * 移出 core 的 feature（shell / memory / tts / visual / audio-feedback 等）
 * 的状态契约登记随源码归属迁移至各自生态包的测试。
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
  'example-feature': () => new ExampleFeature(),
  'file-history': () => new FileHistoryFeature(),
  'handoff-seed': () => new HandoffSeedFeature({ handoff: {} }),
  lsp: () => new LspFeature(),
  'opencode-basic': () => new OpencodeBasicFeature(),
  'output-guard': () => new OutputGuardFeature(),
  subagent: () => new SubAgentFeature(),
  todo: () => new TodoFeature(),
};

const NO_STATE_FACTORIES: Record<string, () => AgentFeature> = {
  skill: () => new SkillFeature(),
  'user-input': () => new UserInputFeature(),
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
      const dirs = await readdir(resolve(__dirname, '../src/features'));
      // 只统计真正有实现的 feature 目录（排除空目录/纯类型目录）
      const featureDirs = dirs.filter(
        d =>
          !d.includes('.') &&
          readdirSync(resolve(__dirname, '../src/features', d)).some(f => f === 'index.ts'),
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
      features.set('skill', new SkillFeature());

      const captured = captureFeatureSnapshots(features);
      expect(captured.map(c => c.featureName)).toEqual(['example-feature']);
    });
  });

  describe('快照字段名契约（不乱命名）', () => {
    it('各 feature captureState 顶层字段稳定', async () => {
      const cases: Array<[string, string[]]> = [
        ['example-feature', ['counter', 'enabled', 'lastInput', 'notes']],
        ['handoff-seed', ['injected']],
        ['output-guard', ['truncateCount']],
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

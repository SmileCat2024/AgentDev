import { describe, it, expect, beforeEach } from 'vitest';
import { UsageStats } from '../../core/usage.js';
import type { UsageInfo } from '../../core/usage.js';

/** Helper: create a basic UsageInfo */
function makeUsage(input: number, output: number): UsageInfo {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
  };
}

/** Helper: create a UsageInfo with all optional fields */
function makeFullUsage(input: number, output: number, extras: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...extras,
  };
}

describe('UsageStats', () => {
  let stats: UsageStats;

  beforeEach(() => {
    stats = new UsageStats();
  });

  // ========== record ==========

  describe('record()', () => {
    it('应累加 input/output/total tokens', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(0, 1, makeUsage(200, 80));

      const total = stats.getTotalUsage();
      expect(total.inputTokens).toBe(300);
      expect(total.outputTokens).toBe(130);
      expect(total.totalTokens).toBe(430);
    });

    it('应累加可选字段（cacheCreation, cacheRead, reasoning, audio）', () => {
      stats.record(0, 0, makeFullUsage(100, 50, {
        cacheCreationTokens: 30,
        cacheReadTokens: 20,
        reasoningTokens: 40,
        audioTokens: 10,
      }));
      stats.record(0, 1, makeFullUsage(50, 25, {
        cacheCreationTokens: 15,
        cacheReadTokens: 35,
        reasoningTokens: 5,
        audioTokens: 8,
      }));

      const total = stats.getTotalUsage();
      expect(total.cacheCreationTokens).toBe(45);
      expect(total.cacheReadTokens).toBe(55);
      expect(total.reasoningTokens).toBe(45);
      expect(total.audioTokens).toBe(18);
    });

    it('多次 record 应正确聚合到 session 级', () => {
      stats.record(0, 0, makeUsage(10, 5));
      stats.record(1, 0, makeUsage(20, 10));
      stats.record(2, 0, makeUsage(30, 15));

      const total = stats.getTotalUsage();
      expect(total.inputTokens).toBe(60);
      expect(total.outputTokens).toBe(30);
      expect(total.totalTokens).toBe(90);
    });

    it('同一 callIndex 的多次 record 应聚合到同一 CallUsageSummary', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(0, 1, makeUsage(200, 80));
      stats.record(0, 2, makeUsage(50, 20));

      const call = stats.getCallUsage(0);
      expect(call).toBeDefined();
      expect(call!.totalUsage.inputTokens).toBe(350);
      expect(call!.totalUsage.outputTokens).toBe(150);
      expect(call!.totalUsage.totalTokens).toBe(500);
      expect(call!.stepCount).toBe(3);
    });

    it('不同 callIndex 应创建独立的 CallUsageSummary', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(1, 0, makeUsage(200, 80));

      const call0 = stats.getCallUsage(0);
      const call1 = stats.getCallUsage(1);
      expect(call0!.totalUsage.inputTokens).toBe(100);
      expect(call1!.totalUsage.inputTokens).toBe(200);
    });

    it('stepCount 应正确递增', () => {
      stats.record(0, 0, makeUsage(10, 5));
      stats.record(0, 1, makeUsage(20, 10));
      stats.record(0, 5, makeUsage(30, 15));

      const call = stats.getCallUsage(0);
      expect(call!.stepCount).toBe(3);
    });

    it('有 cacheReadTokens 时应增加 cacheHitRequests 计数', () => {
      stats.record(0, 0, makeFullUsage(100, 50, { cacheReadTokens: 20 }));
      stats.record(0, 1, makeFullUsage(50, 25, { cacheReadTokens: 30 }));

      const call = stats.getCallUsage(0);
      expect(call!.cacheHitRequests).toBe(2);
      expect(stats.getTotalCacheHitRequests()).toBe(2);
    });

    it('无 cacheReadTokens 时不应增加 cacheHitRequests', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(0, 1, makeFullUsage(50, 25, { cacheCreationTokens: 30 }));

      const call = stats.getCallUsage(0);
      expect(call!.cacheHitRequests).toBe(0);
      expect(stats.getTotalCacheHitRequests()).toBe(0);
    });

    it('应更新 lastRequestUsage', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(0, 1, makeUsage(200, 80));

      const last = stats.getLastRequestUsage();
      expect(last).toEqual(makeUsage(200, 80));
    });
  });

  // ========== endCall ==========

  describe('endCall()', () => {
    it('应设置 callSummary 的 endTime', () => {
      stats.record(0, 0, makeUsage(100, 50));
      expect(stats.getCallUsage(0)!.endTime).toBeUndefined();

      stats.endCall(0);
      expect(stats.getCallUsage(0)!.endTime).toBeDefined();
      expect(typeof stats.getCallUsage(0)!.endTime).toBe('number');
    });

    it('不存在的 callIndex 应安全忽略', () => {
      // Should not throw
      expect(() => stats.endCall(999)).not.toThrow();
    });
  });

  // ========== getTotalUsage ==========

  describe('getTotalUsage()', () => {
    it('应返回 session 级累计用量', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(1, 0, makeUsage(200, 80));

      const total = stats.getTotalUsage();
      expect(total.inputTokens).toBe(300);
      expect(total.outputTokens).toBe(130);
      expect(total.totalTokens).toBe(430);
    });

    it('返回值应为副本（不可变性）', () => {
      stats.record(0, 0, makeUsage(100, 50));
      const total = stats.getTotalUsage();
      total.inputTokens = 9999;

      // Original should be unchanged
      expect(stats.getTotalUsage().inputTokens).toBe(100);
    });
  });

  // ========== getCallUsage ==========

  describe('getCallUsage()', () => {
    it('应返回指定 call 的汇总', () => {
      stats.record(0, 0, makeUsage(100, 50));

      const call = stats.getCallUsage(0);
      expect(call).toBeDefined();
      expect(call!.callIndex).toBe(0);
      expect(call!.totalUsage.inputTokens).toBe(100);
    });

    it('不存在的 callIndex 应返回 undefined', () => {
      expect(stats.getCallUsage(999)).toBeUndefined();
    });

    it('返回值应为副本', () => {
      stats.record(0, 0, makeUsage(100, 50));
      const call = stats.getCallUsage(0);
      call!.totalUsage.inputTokens = 9999;
      call!.stepCount = 9999;

      // Original should be unchanged
      expect(stats.getCallUsage(0)!.totalUsage.inputTokens).toBe(100);
      expect(stats.getCallUsage(0)!.stepCount).toBe(1);
    });
  });

  // ========== getAllCallUsage ==========

  describe('getAllCallUsage()', () => {
    it('应返回所有 call 的用量汇总', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(1, 0, makeUsage(200, 80));
      stats.record(2, 0, makeUsage(50, 25));

      const all = stats.getAllCallUsage();
      expect(all).toHaveLength(3);
      expect(all.map(c => c.callIndex)).toEqual([0, 1, 2]);
    });

    it('无数据时应返回空数组', () => {
      expect(stats.getAllCallUsage()).toEqual([]);
    });

    it('返回值应为副本', () => {
      stats.record(0, 0, makeUsage(100, 50));
      const all = stats.getAllCallUsage();
      all[0].totalUsage.inputTokens = 9999;

      // Original should be unchanged
      expect(stats.getCallUsage(0)!.totalUsage.inputTokens).toBe(100);
    });
  });

  // ========== getTotalRequests ==========

  describe('getTotalRequests()', () => {
    it('应返回总请求数', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(0, 1, makeUsage(200, 80));
      stats.record(1, 0, makeUsage(50, 25));

      expect(stats.getTotalRequests()).toBe(3);
    });
  });

  // ========== getReport ==========

  describe('getReport()', () => {
    it('应包含 Total/Input/Output 行', () => {
      stats.record(0, 0, makeUsage(1000, 500));
      const report = stats.getReport();

      expect(report).toContain('Total: 1,500 tokens');
      expect(report).toContain('Input: 1,000');
      expect(report).toContain('Output: 500');
    });

    it('有 cache 数据时应包含 Cache 行', () => {
      stats.record(0, 0, makeFullUsage(100, 50, {
        cacheCreationTokens: 200,
        cacheReadTokens: 300,
      }));
      const report = stats.getReport();

      expect(report).toContain('Cache Read: 300');
      expect(report).toContain('Cache Creation: 200');
    });

    it('有 reasoning 数据时应包含 Reasoning 行', () => {
      stats.record(0, 0, makeFullUsage(100, 50, { reasoningTokens: 75 }));
      const report = stats.getReport();

      expect(report).toContain('Reasoning: 75');
    });

    it('应包含 Requests 计数', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(1, 0, makeUsage(200, 80));
      const report = stats.getReport();

      expect(report).toContain('Requests: 2');
    });

    it('无 cache/reasoning 时不应包含对应行', () => {
      stats.record(0, 0, makeUsage(100, 50));
      const report = stats.getReport();

      expect(report).not.toContain('Cache Read');
      expect(report).not.toContain('Reasoning');
    });
  });

  // ========== 快照 ==========

  describe('快照 (toSnapshot / fromSnapshot)', () => {
    it('toSnapshot → fromSnapshot 应正确恢复所有状态', () => {
      stats.record(0, 0, makeFullUsage(100, 50, { cacheReadTokens: 30 }));
      stats.record(0, 1, makeUsage(200, 80));
      stats.record(1, 0, makeFullUsage(50, 25, { reasoningTokens: 10 }));
      stats.endCall(0);

      const snapshot = stats.toSnapshot();

      const restored = new UsageStats();
      restored.fromSnapshot(snapshot);

      const total = restored.getTotalUsage();
      expect(total.inputTokens).toBe(350);
      expect(total.outputTokens).toBe(155);
      expect(total.totalTokens).toBe(505);
      expect(total.cacheReadTokens).toBe(30);
      expect(total.reasoningTokens).toBe(10);
    });

    it('fromSnapshot 后 totalRequests 应一致', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(1, 0, makeUsage(200, 80));

      const snapshot = stats.toSnapshot();

      const restored = new UsageStats();
      restored.fromSnapshot(snapshot);

      expect(restored.getTotalRequests()).toBe(2);
    });

    it('fromSnapshot 后 getAllCallUsage 应一致', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(0, 1, makeUsage(200, 80));
      stats.record(1, 0, makeUsage(50, 25));
      stats.endCall(0);

      const snapshot = stats.toSnapshot();

      const restored = new UsageStats();
      restored.fromSnapshot(snapshot);

      const originalCalls = stats.getAllCallUsage();
      const restoredCalls = restored.getAllCallUsage();

      expect(restoredCalls).toHaveLength(originalCalls.length);
      expect(restoredCalls[0]).toEqual(originalCalls[0]);
      expect(restoredCalls[1]).toEqual(originalCalls[1]);
    });

    it('fromSnapshot 后 lastRequestUsage 应一致', () => {
      stats.record(0, 0, makeUsage(100, 50));
      stats.record(0, 1, makeUsage(200, 80));

      const snapshot = stats.toSnapshot();

      const restored = new UsageStats();
      restored.fromSnapshot(snapshot);

      const originalLast = stats.getLastRequestUsage();
      const restoredLast = restored.getLastRequestUsage();
      expect(restoredLast).toEqual(originalLast);
    });

    it('fromSnapshot 后 totalCacheHitRequests 应一致', () => {
      stats.record(0, 0, makeFullUsage(100, 50, { cacheReadTokens: 30 }));
      stats.record(1, 0, makeFullUsage(50, 25, { cacheReadTokens: 20 }));

      const snapshot = stats.toSnapshot();

      const restored = new UsageStats();
      restored.fromSnapshot(snapshot);

      expect(restored.getTotalCacheHitRequests()).toBe(2);
    });

    it('快照数据应为深拷贝（修改快照不影响原对象）', () => {
      stats.record(0, 0, makeUsage(100, 50));

      const snapshot = stats.toSnapshot();
      snapshot.totalUsage.inputTokens = 9999;
      snapshot.calls[0].stepCount = 9999;

      // Original should be unchanged
      expect(stats.getTotalUsage().inputTokens).toBe(100);
      expect(stats.getCallUsage(0)!.stepCount).toBe(1);
    });
  });

  // ========== reset ==========

  describe('reset()', () => {
    it('应清零所有统计', () => {
      stats.record(0, 0, makeFullUsage(100, 50, {
        cacheCreationTokens: 30,
        cacheReadTokens: 20,
        reasoningTokens: 40,
        audioTokens: 10,
      }));
      stats.record(1, 0, makeUsage(200, 80));
      stats.endCall(0);

      stats.reset();

      const total = stats.getTotalUsage();
      expect(total.inputTokens).toBe(0);
      expect(total.outputTokens).toBe(0);
      expect(total.totalTokens).toBe(0);
      expect(total.cacheCreationTokens).toBeUndefined();
      expect(total.cacheReadTokens).toBeUndefined();
      expect(total.reasoningTokens).toBeUndefined();
      expect(total.audioTokens).toBeUndefined();

      expect(stats.getTotalRequests()).toBe(0);
      expect(stats.getTotalCacheHitRequests()).toBe(0);
      expect(stats.getAllCallUsage()).toEqual([]);
      expect(stats.getLastRequestUsage()).toBeNull();
    });
  });
});

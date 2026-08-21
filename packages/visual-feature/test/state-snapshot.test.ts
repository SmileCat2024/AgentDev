/**
 * VisualFeature 状态快照语义测试
 *
 * 从原 src/test/feature-rollback-compat.test.ts 拆出：
 * captureState / restoreState 的值快照语义（visual 侧回归）。
 */

import { describe, it, expect } from 'vitest';
import { VisualFeature } from '../src/index.js';

describe('VisualFeature state snapshot', () => {
  it('should capture VisualFeature state correctly', () => {
    const feature = new VisualFeature({
      monitoring: { enabled: false },
      checkPythonEnv: false,
    });

    feature.restoreState({
      visualEnabled: true,
      injectionState: {
        isFirstInjection: false,
        lastInjectedWindows: [[
          'hwnd-1',
          {
            title: 'Editor',
            status: 'Normal',
            processPath: 'C:/editor.exe',
            isForeground: true,
          },
        ]],
        lastInjectedAnalyses: [['hwnd-1', 'hash-1']],
        focusHistory: ['hwnd-1'],
        lastForegroundHwnd: 'hwnd-1',
      },
    });

    const snapshot = feature.captureState() as any;
    expect(snapshot.visualEnabled).toBe(true);
    expect(snapshot.injectionState.lastInjectedWindows).toHaveLength(1);
    expect(snapshot.injectionState.lastInjectedAnalyses).toHaveLength(1);
  });
});

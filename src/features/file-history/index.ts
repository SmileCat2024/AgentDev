/**
 * FileHistoryFeature - 文件修改历史追踪与回退
 *
 * 独立 Feature，无侵入地接入 AgentDev 的 checkpoint/rollback 体系：
 *
 * - @ToolUse 反向钩子：在 write/edit 执行前自动备份文件
 * - @CallStart 反向钩子：在每轮用户输入时创建快照
 * - captureState/restoreState：与 Agent 的 CallRollback 集成（仅恢复内存状态）
 * - rewindToSnapshot / rewindToLastSnapshot：用户显式触发的文件回退
 *
 * 文件回退是独立于对话回退的操作（与 Claude Code 的设计一致），
 * 用户可以选择"仅回退代码"/"仅回退对话"/"两者都回退"。
 *
 * 使用方式（消费端，如 Claw）：
 *   const fh = agent.features?.get('file-history');
 *   if (fh) {
 *     const snapshots = fh.getSnapshotList();
 *     await fh.rewindToSnapshot(selectedId);
 *   }
 */

import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import type { AgentFeature, FeatureStateSnapshot, FeatureInitContext, FeatureContext, PackageInfo } from '../../core/feature.js'
import { getPackageInfoFromSource } from '../../core/feature.js'
import type { ToolContext } from '../../core/lifecycle.js'
import type { DecisionResult } from '../../core/lifecycle.js'
import { ToolUse, CallStart, Decision } from '../../core/hooks-decorator.js'
import {
  createInitialState,
  trackEdit,
  makeSnapshot,
  rewindToSnapshot as rewindToSnapshotCore,
  rewindToLastSnapshot as rewindToLastSnapshotCore,
  getDiffStats as getDiffStatsCore,
  type FileHistoryState,
  type DiffStats,
} from './file-history.js'

export interface FileHistoryFeatureConfig {
  /** 覆盖工作区目录，默认 process.cwd() */
  workspaceDir?: string
}

export type SnapshotInfo = {
  id: number
  timestamp: number
  trackedFileCount: number
}

export class FileHistoryFeature implements AgentFeature {
  readonly name = 'file-history'
  readonly dependencies: string[] = []
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/')
  readonly description = '追踪文件修改历史，支持代码回退到任意轮次的状态。'

  private _packageInfo: PackageInfo | null = null
  private logger: any
  private state: FileHistoryState | null = null
  private readonly workspaceDir: string

  constructor(config: FileHistoryFeatureConfig = {}) {
    this.workspaceDir = config.workspaceDir || process.cwd()
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source)
    }
    return this._packageInfo
  }

  // ========== 生命周期 ==========

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger
    const sessionId = randomUUID()
    this.state = createInitialState(sessionId, this.workspaceDir)

    this.logger?.info('File history initialized', {
      feature: 'file-history',
      sessionId,
      workspaceDir: this.workspaceDir,
    })
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    this.state = null
  }

  // ========== 反向钩子 ==========

  /**
   * @ToolUse 反向钩子：在 write/edit 工具执行前备份文件
   *
   * 在所有 Feature 的 @ToolUse 钩子中，本钩子只关注 write/edit 两个工具，
   * 其余一律放行 (Decision.Continue)。
   */
  @ToolUse
  async trackFileEdits(ctx: ToolContext): Promise<DecisionResult> {
    if (!this.state) return Decision.Continue

    const toolName = ctx.call.name
    if (toolName !== 'write' && toolName !== 'edit') {
      return Decision.Continue
    }

    const filePath = ctx.call.arguments?.filePath as string
    if (!filePath) return Decision.Continue

    try {
      this.state = await trackEdit(this.state, filePath)
    } catch (error) {
      // 备份失败不应阻止工具执行，记录日志后放行
      this.logger?.error('File history track failed', {
        filePath,
        toolName,
        error: error instanceof Error ? error.message : String(error),
        feature: 'file-history',
      })
    }

    return Decision.Continue
  }

  /**
   * @CallStart 反向钩子：每轮用户输入时创建文件快照
   *
   * 第一次 CallStart 创建空快照，后续 CallStart 检测已追踪文件是否有变化，
   * 有变化的创建新版本备份。
   */
  @CallStart
  async onCallStart(_ctx: any): Promise<void> {
    if (!this.state) return

    try {
      this.state = await makeSnapshot(this.state)
    } catch (error) {
      this.logger?.error('File history snapshot failed', {
        error: error instanceof Error ? error.message : String(error),
        feature: 'file-history',
      })
    }
  }

  // ========== Checkpoint 集成 ==========

  /**
   * 捕获当前文件历史状态（纯内存，不碰磁盘）
   *
   * 由 Agent 的 commitCallCheckpoint 调用。
   * 保存快照元数据，使得 rollbackToCall 时能恢复到对应的文件历史状态。
   */
  captureState(): FeatureStateSnapshot {
    if (!this.state) return null
    // 只保存可序列化的元数据，不保存文件内容
    return {
      snapshots: this.state.snapshots,
      trackedFiles: this.state.trackedFiles,
      snapshotCounter: this.state.snapshotCounter,
      sessionId: this.state.sessionId,
      workspaceDir: this.state.workspaceDir,
    }
  }

  /**
   * 恢复文件历史状态（仅恢复内存，不恢复磁盘文件）
   *
   * 在三种场景下被调用：step rollback、call rollback、session load。
   * 这里只恢复内存中的快照索引，不做文件回退。
   * 文件回退由用户显式调用 rewindToSnapshot / rewindToLastSnapshot 触发。
   */
  restoreState(snapshot: FeatureStateSnapshot): void {
    const prevState = snapshot as FileHistoryState | null
    if (!prevState || !prevState.snapshots) return

    this.state = {
      snapshots: prevState.snapshots,
      trackedFiles: prevState.trackedFiles ?? [],
      snapshotCounter: prevState.snapshotCounter ?? prevState.snapshots.length,
      sessionId: prevState.sessionId,
      workspaceDir: prevState.workspaceDir ?? this.workspaceDir,
    }
  }

  // ========== 公开 API（供消费端调用） ==========

  /**
   * 获取快照列表（供 UI 展示）
   */
  getSnapshotList(): SnapshotInfo[] {
    if (!this.state) return []
    return this.state.snapshots.map(s => ({
      id: s.id,
      timestamp: s.timestamp,
      trackedFileCount: Object.keys(s.trackedFileBackups).length,
    }))
  }

  /**
   * 获取当前追踪的文件数量
   */
  getTrackedFileCount(): number {
    return this.state?.trackedFiles.length ?? 0
  }

  /**
   * 获取快照数量
   */
  getSnapshotCount(): number {
    return this.state?.snapshots.length ?? 0
  }

  /**
   * 回退文件到指定快照
   *
   * @returns 被修改的文件路径列表
   */
  async rewindToSnapshot(snapshotId: number): Promise<string[]> {
    if (!this.state) throw new Error('File history not initialized')
    const changed = await rewindToSnapshotCore(this.state, snapshotId)
    this.logger?.info('Files rewound to snapshot', {
      snapshotId,
      changedFilesCount: changed.length,
      changedFiles: changed,
      feature: 'file-history',
    })
    return changed
  }

  /**
   * 回退文件到当前内存状态的最后一个快照
   *
   * 典型用法：先 rollbackToCall 恢复对话 + 内存状态，再调此方法恢复文件。
   *   await agent.rollbackToCall(targetCallIndex)
   *   const fh = agent.features?.get('file-history')
   *   await fh?.rewindToLastSnapshot()
   */
  async rewindToLastSnapshot(): Promise<string[]> {
    if (!this.state) throw new Error('File history not initialized')
    const changed = await rewindToLastSnapshotCore(this.state)
    this.logger?.info('Files rewound to last snapshot', {
      changedFilesCount: changed.length,
      changedFiles: changed,
      feature: 'file-history',
    })
    return changed
  }

  /**
   * 计算回退到指定快照的 diff 统计（预览用，不修改文件）
   */
  async getDiffStats(snapshotId: number): Promise<DiffStats> {
    if (!this.state) return { filesChanged: [], insertions: 0, deletions: 0 }
    return getDiffStatsCore(this.state, snapshotId)
  }
}

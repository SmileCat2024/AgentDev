/**
 * 文件历史核心逻辑
 *
 * 改写自 Claude Code 的 fileHistory.ts，去掉 React 状态管理、遥测、VSCode 通知等，
 * 保留纯粹的备份/快照/回退能力。
 *
 * 设计要点：
 * - 备份文件以 {sha256(path)[:16]}@v{N} 命名，存放在 ~/.agentdev/file-history/{sessionId}/
 * - 快照绑定一个递增 ID，记录当时所有被追踪文件的备份版本
 * - 快照上限 100，超过自动淘汰最早的
 * - 变更检测走三层快速路径：stat → size → mtime → content
 */

import { createHash } from 'crypto'
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  unlink,
} from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import { homedir } from 'os'
import type { Stats } from 'fs'

// ========== 类型 ==========

type BackupFileName = string | null // null = 该版本文件不存在

export interface FileHistoryBackup {
  backupFileName: BackupFileName
  version: number
}

export interface FileHistorySnapshot {
  id: number
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: number
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[]
  trackedFiles: string[]
  snapshotCounter: number
  sessionId: string
  workspaceDir: string
}

export interface DiffStats {
  filesChanged: string[]
  insertions: number
  deletions: number
}

const MAX_SNAPSHOTS = 100

// ========== 路径工具 ==========

export function getBackupDir(sessionId: string): string {
  return join(homedir(), '.agentdev', 'file-history', sessionId)
}

function getBackupFileName(filePath: string, version: number): string {
  const hash = createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16)
  return `${hash}@v${version}`
}

function resolveBackupPath(backupFileName: string, sessionId: string): string {
  return join(getBackupDir(sessionId), backupFileName)
}

function toTrackingPath(filePath: string, workspaceDir: string): string {
  if (!isAbsolute(filePath)) return filePath
  if (filePath.startsWith(workspaceDir)) {
    return relative(workspaceDir, filePath)
  }
  return filePath
}

function toAbsolutePath(trackingPath: string, workspaceDir: string): string {
  if (isAbsolute(trackingPath)) return trackingPath
  return join(workspaceDir, trackingPath)
}

// ========== 备份操作 ==========

async function createBackup(
  filePath: string,
  version: number,
  sessionId: string,
): Promise<FileHistoryBackup> {
  const backupFileName = getBackupFileName(filePath, version)
  const backupPath = resolveBackupPath(backupFileName, sessionId)

  // 源文件不存在 → 记录 null 标记
  let srcStats: Stats
  try {
    srcStats = await stat(filePath)
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return { backupFileName: null, version }
    }
    throw e
  }

  // copyFile 不经过 JS 堆，大文件安全
  try {
    await copyFile(filePath, backupPath)
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      await mkdir(dirname(backupPath), { recursive: true })
      await copyFile(filePath, backupPath)
    } else {
      throw e
    }
  }

  await chmod(backupPath, srcStats.mode)
  return { backupFileName, version }
}

/**
 * 三层快速路径：stat → size/mode → mtime → content
 * 来自 Claude Code 的 checkOriginFileChanged
 */
async function fileHasChanged(
  originalFile: string,
  backupFileName: string,
  sessionId: string,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName, sessionId)

  let origStats: Stats | null = null
  try { origStats = await stat(originalFile) } catch {}

  let bakStats: Stats | null = null
  try { bakStats = await stat(backupPath) } catch {}

  // 一个存在一个不存在 → 变了
  if ((origStats === null) !== (bakStats === null)) return true
  // 都不存在 → 没变
  if (!origStats || !bakStats) return false

  // size 或 mode 不同 → 变了
  if (origStats.size !== bakStats.size || origStats.mode !== bakStats.mode) {
    return true
  }

  // mtime 快速路径：原文件比备份旧 → 没变（跳过内容比较）
  if (origStats.mtimeMs < bakStats.mtimeMs) return false

  // 兜底：读内容比较
  try {
    const [orig, bak] = await Promise.all([
      readFile(originalFile, 'utf-8'),
      readFile(backupPath, 'utf-8'),
    ])
    return orig !== bak
  } catch {
    return true
  }
}

async function restoreFile(
  filePath: string,
  backupFileName: string,
  sessionId: string,
): Promise<void> {
  const backupPath = resolveBackupPath(backupFileName, sessionId)
  try {
    await copyFile(backupPath, filePath)
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      await mkdir(dirname(filePath), { recursive: true })
      await copyFile(backupPath, filePath)
    } else {
      throw e
    }
  }
}

// ========== 状态初始化 ==========

export function createInitialState(
  sessionId: string,
  workspaceDir: string,
): FileHistoryState {
  return {
    snapshots: [],
    trackedFiles: [],
    snapshotCounter: 0,
    sessionId,
    workspaceDir,
  }
}

// ========== 核心操作 ==========

/**
 * 追踪文件编辑 —— 在 write/edit 工具执行前调用
 *
 * 只在当前最新快照中还没有该文件备份时才创建 v1 备份。
 * 同一快照内多次调用（如同一轮内编辑同一文件两次）会跳过，保留首次编辑前的状态。
 */
export async function trackEdit(
  state: FileHistoryState,
  filePath: string,
): Promise<FileHistoryState> {
  const trackingPath = toTrackingPath(filePath, state.workspaceDir)
  const latestSnapshot = state.snapshots[state.snapshots.length - 1]

  if (!latestSnapshot) return state

  // 已在当前快照中追踪过 → 跳过（保持 pre-edit 的 v1 备份不被覆盖）
  if (latestSnapshot.trackedFileBackups[trackingPath]) {
    return state
  }

  const absolutePath = toAbsolutePath(trackingPath, state.workspaceDir)
  const backup = await createBackup(absolutePath, 1, state.sessionId)

  const newTrackedFiles = state.trackedFiles.includes(trackingPath)
    ? state.trackedFiles
    : [...state.trackedFiles, trackingPath]

  // 更新最新快照，添加该文件的备份
  return {
    ...state,
    trackedFiles: newTrackedFiles,
    snapshots: state.snapshots.map((s, i) =>
      i === state.snapshots.length - 1
        ? {
            ...s,
            trackedFileBackups: {
              ...s.trackedFileBackups,
              [trackingPath]: backup,
            },
          }
        : s
    ),
  }
}

/**
 * 创建快照 —— 在每轮 Call 开始时调用
 *
 * 遍历所有已追踪文件，有变化的创建新版本备份，没变化的复用上一版本引用。
 */
export async function makeSnapshot(
  state: FileHistoryState,
): Promise<FileHistoryState> {
  const latestSnapshot = state.snapshots[state.snapshots.length - 1]
  const newBackups: Record<string, FileHistoryBackup> = {}

  if (latestSnapshot) {
    await Promise.all(
      state.trackedFiles.map(async (trackingPath) => {
        const absolutePath = toAbsolutePath(trackingPath, state.workspaceDir)
        const lastBackup = latestSnapshot.trackedFileBackups[trackingPath]
        const nextVersion = lastBackup ? lastBackup.version + 1 : 1

        let fileStats: Stats | undefined
        try {
          fileStats = await stat(absolutePath)
        } catch (e: any) {
          if (e.code === 'ENOENT') {
            // 文件被删了
            newBackups[trackingPath] = { backupFileName: null, version: nextVersion }
            return
          }
          throw e
        }

        // 文件存在，检查是否有变化
        if (
          lastBackup &&
          lastBackup.backupFileName !== null &&
          !(await fileHasChanged(absolutePath, lastBackup.backupFileName, state.sessionId))
        ) {
          // 未变化，复用上一版本
          newBackups[trackingPath] = lastBackup
          return
        }

        // 有变化，创建新版本备份
        newBackups[trackingPath] = await createBackup(
          absolutePath,
          nextVersion,
          state.sessionId,
        )
      }),
    )
  }

  // 继承上一快照中未被新快照覆盖的备份
  if (latestSnapshot) {
    for (const path of state.trackedFiles) {
      if (!(path in newBackups) && latestSnapshot.trackedFileBackups[path]) {
        newBackups[path] = latestSnapshot.trackedFileBackups[path]
      }
    }
  }

  const newSnapshot: FileHistorySnapshot = {
    id: state.snapshotCounter,
    trackedFileBackups: newBackups,
    timestamp: Date.now(),
  }

  const allSnapshots = [...state.snapshots, newSnapshot]

  return {
    ...state,
    snapshots:
      allSnapshots.length > MAX_SNAPSHOTS
        ? allSnapshots.slice(-MAX_SNAPSHOTS)
        : allSnapshots,
    snapshotCounter: state.snapshotCounter + 1,
  }
}

/**
 * 回退文件到指定快照
 *
 * 遍历所有已追踪文件，将其恢复到目标快照记录的版本。
 * 返回被修改的文件路径列表。
 */
export async function rewindToSnapshot(
  state: FileHistoryState,
  snapshotId: number,
): Promise<string[]> {
  const targetSnapshot = [...state.snapshots].reverse().find(s => s.id === snapshotId)
  if (!targetSnapshot) {
    throw new Error(`Snapshot ${snapshotId} not found`)
  }

  return applySnapshot(state, targetSnapshot)
}

/**
 * 回退到给定状态的最后一个快照（rollbackToCall 后调用）
 */
export async function rewindToLastSnapshot(
  state: FileHistoryState,
): Promise<string[]> {
  const lastSnapshot = state.snapshots[state.snapshots.length - 1]
  if (!lastSnapshot) return []
  return applySnapshot(state, lastSnapshot)
}

/**
 * 计算回退到指定快照的 diff 统计（不实际修改文件）
 */
export async function getDiffStats(
  state: FileHistoryState,
  snapshotId: number,
): Promise<DiffStats> {
  const targetSnapshot = [...state.snapshots].reverse().find(s => s.id === snapshotId)
  if (!targetSnapshot) {
    return { filesChanged: [], insertions: 0, deletions: 0 }
  }

  // 动态导入 diffLines 避免硬依赖
  const { diffLines } = await import('diff')

  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0

  for (const trackingPath of state.trackedFiles) {
    const absolutePath = toAbsolutePath(trackingPath, state.workspaceDir)
    const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]

    const backupFileName: BackupFileName | undefined = targetBackup
      ? targetBackup.backupFileName
      : getBackupFileNameFirstVersion(trackingPath, state)

    if (backupFileName === undefined) continue

    try {
      let currentContent: string | null = null
      let snapshotContent: string | null = null

      try {
        currentContent = await readFile(absolutePath, 'utf-8')
      } catch {}

      if (backupFileName !== null) {
        const backupPath = resolveBackupPath(backupFileName, state.sessionId)
        try {
          snapshotContent = await readFile(backupPath, 'utf-8')
        } catch {}
      }

      const changes = diffLines(currentContent ?? '', snapshotContent ?? '')
      let hasChanges = false
      for (const c of changes) {
        if (c.added) { insertions += c.count || 0; hasChanges = true }
        if (c.removed) { deletions += c.count || 0; hasChanges = true }
      }
      if (hasChanges) filesChanged.push(absolutePath)
    } catch {
      // 跳过无法比较的文件
    }
  }

  return { filesChanged, insertions, deletions }
}

// ========== 内部工具 ==========

async function applySnapshot(
  state: FileHistoryState,
  targetSnapshot: FileHistorySnapshot,
): Promise<string[]> {
  const changedFiles: string[] = []

  for (const trackingPath of state.trackedFiles) {
    const absolutePath = toAbsolutePath(trackingPath, state.workspaceDir)
    const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]

    const backupFileName: BackupFileName | undefined = targetBackup
      ? targetBackup.backupFileName
      : getBackupFileNameFirstVersion(trackingPath, state)

    if (backupFileName === undefined) continue

    if (backupFileName === null) {
      // 目标版本文件不存在，删除当前文件
      try {
        await unlink(absolutePath)
        changedFiles.push(absolutePath)
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e
      }
      continue
    }

    // 仅当文件确实变了才恢复
    if (await fileHasChanged(absolutePath, backupFileName, state.sessionId)) {
      await restoreFile(absolutePath, backupFileName, state.sessionId)
      changedFiles.push(absolutePath)
    }
  }

  return changedFiles
}

/**
 * 查找文件最早的 v1 备份（用于回退到快照中未追踪的文件）
 */
function getBackupFileNameFirstVersion(
  trackingPath: string,
  state: FileHistoryState,
): BackupFileName | undefined {
  for (const s of state.snapshots) {
    const backup = s.trackedFileBackups[trackingPath]
    if (backup !== undefined && backup.version === 1) {
      return backup.backupFileName
    }
  }
  return undefined
}

/**
 * Shell Feature - 独立 npm 包
 *
 * 支持 Bash（Windows: Git Bash / Linux/macOS: 原生 bash）和 PowerShell 两种 Shell 环境。
 * 根据用户配置和运行时探测结果，条件注册 Bash 和/或 PowerShell 工具。
 *
 * @example
 * ```typescript
 * import { ShellFeature } from '@agentdevjs/shell-feature';
 * import { BasicAgent } from '@agentdevjs/core';
 *
 * const agent = new BasicAgent().use(new ShellFeature());
 * ```
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import type { AgentFeature, FeatureInitContext, FeatureManifestDefinition, PackageInfo } from '@agentdevjs/core';
import type { Tool } from '@agentdevjs/core';
import type {
  CallStartContext,
  HookDeclarations,
  PendingWakeup,
  StepFinishDecisionContext,
  DecisionResult,
} from '@agentdevjs/core';
import { CoreLifecycle, Decision, getPackageInfoFromSource } from '@agentdevjs/core';
import { createShellCommandTool, findGitBashPath } from './tools.js';
import { createPowerShellTool, findPowerShellPath } from './powershell.js';
import { createSafeTrashDeleteTool, createSafeTrashListTool, createSafeTrashRestoreTool } from './tools-trash.js';
import { BgRegistry, FOREGROUND_BUDGET_DEFAULT_MS } from './bg-core.js';
import type { BgObserver, BgTask } from './bg-core.js';
import {
  BASH_BG_INLINE_DESCRIPTION,
  createBashBgTool,
  createBgKillTool,
  createBgListTool,
  createBgStatusTool,
  createBgTuneTool,
  createBgWaitTool,
  createBgWriteTool,
} from './bg-tools.js';

const __filename = fileURLToPath(import.meta.url);

export interface ShellFeatureConfig {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
  /** 宿主集成观察者：任务登记/输出（节流）/汇报/就绪/终态/调速时回调。 */
  bgObserver?: BgObserver;
  /**
   * 建表会话归属（ADR-0019 决策 8）：宿主多会话拓扑下由装配方声明，
   * 随任务登记盖戳、随通知投递。缺省不携带，行为与现状一致。
   */
  sessionId?: string;
}

interface ResolvedShellConfig {
  bashEnabled: boolean;
  bashPath?: string;
  powershellEnabled: boolean;
  powershellPath?: string;
  /** 前台命令固定预算（毫秒）：超预算不打断，转后台继续运行；默认 20000 */
  defaultTimeoutMs: number;
}

/** 前台固定预算契约值（与 bg-core 保持一致）。 */
const DEFAULT_TIMEOUT_MS = FOREGROUND_BUDGET_DEFAULT_MS; // 20 seconds

function resolvePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Shell Feature 实现
 */
export class ShellFeature implements AgentFeature {
  readonly name = 'shell';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '提供 Bash/PowerShell 命令执行能力，以及安全删除、恢复和查看垃圾桶工具。';

  /**
   * bg_wait 安排到点检查后结束当前回合：等待不占工具调用，由通知推送
   * （节拍/静默/终态同一管线）唤醒。到点检查触发或任务终态后 waitTimer
   * 清除，此后不再干预流程（Continue）。
   */
  static hooks: HookDeclarations = {
    endTurnOnPendingWaitCheck: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
    registerPendingWorkOnCallStart: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };

  private bashDescription?: string;
  private bashBgDescription?: string;
  private powershellDescription?: string;
  private _packageInfo: PackageInfo | null = null;
  private readonly workspaceDir: string;
  private readonly workdir: string;
  private readonly resourceRoot: string;
  private readonly bgObserver?: BgObserver;
  private readonly sessionId?: string;
  /** 后台任务登记表（首次 getAsyncTools 时按 agentId 惰性创建）。 */
  private _registry: BgRegistry | null = null;

  constructor(config: ShellFeatureConfig = {}) {
    this.workspaceDir = config.workspaceDir || process.cwd();
    this.workdir = config.workdir || this.workspaceDir;
    this.resourceRoot = config.resourceRoot || process.cwd();
    this.bgObserver = typeof config.bgObserver === 'function' ? config.bgObserver : undefined;
    this.sessionId = typeof config.sessionId === 'string' && config.sessionId ? config.sessionId : undefined;
  }

  /** 后台任务登记表（惰性创建前为 null）。宿主集成面：状态镜像 / 面板请求转发。 */
  getBgRegistry(): BgRegistry | null {
    return this._registry;
  }

  /**
   * StepFinish guard（advisor）：本回合安排过 bg_wait 到点检查时结束当前
   * call（Decision.Deny 在 react-loop 的既有语义），把等待交给通知推送——
   * 任务提前完成则终态通知先行，否则到点收到检查汇报。无待触发检查时
   * 一律 Continue，不干预正常流程。
   */
  async endTurnOnPendingWaitCheck(_ctx: StepFinishDecisionContext): Promise<DecisionResult> {
    if (!this._registry?.hasActiveWaitCheck()) return Decision.Continue;
    return Decision.Deny;
  }

  /**
   * CallStart（observe）：向 agent 申报 pending-work provider（ADR-0019）。
   *
   * 首个能拿到 agent 引用的时机注册；从共享 BgRegistry 取 running 任务映射
   * 为 PendingWakeup 快照。registry 尚未惰性创建（本实例还没起过后台任务）
   * 时申报空表——同进程其他会话实例建表后，共享表对其可见。每次 CallStart
   * 重复注册幂等（同 source 覆盖）。peer 版本 core 无此 API 时静默降级
   * （回合结束仍判 completed，现状行为）。
   */
  registerPendingWorkOnCallStart(ctx: CallStartContext): void {
    const agent = ctx.agent as
      | { registerPendingWorkProvider?: (source: string, provider: () => PendingWakeup[]) => void }
      | undefined;
    if (typeof agent?.registerPendingWorkProvider !== 'function') return;
    agent.registerPendingWorkProvider('shell', () => {
      const registry = this._registry;
      if (!registry) return [];
      return registry
        .list()
        .filter(snap => snap.status === 'running')
        .map(snap => ({ source: 'shell', id: snap.id, summary: snap.command }));
    });
  }

  /**
   * 获取同步工具（垃圾桶工具）
   */
  getTools(): Tool[] {
    return [
      createSafeTrashDeleteTool(this.workdir),
      createSafeTrashListTool(this.workdir),
      createSafeTrashRestoreTool(this.workdir),
    ];
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1 as const,
      settings: {
        properties: {
          bashEnabled: {
            type: 'boolean',
            title: '启用 Bash',
            description: '启用后，Agent 将获得 Bash 工具。Windows 需要 Git for Windows；Linux/macOS 使用系统自带 Shell。',
            default: true,
          },
          bashPath: {
            type: 'file',
            title: 'Bash 路径',
            description: 'Bash 可执行文件路径。留空时自动检测。',
            placeholder: '自动检测',
          },
          powershellEnabled: {
            type: 'boolean',
            title: '启用 PowerShell',
            description: '启用后，Agent 将获得 PowerShell 工具。Windows 自带 PowerShell 5.1；Linux/macOS 需安装 PowerShell Core (pwsh)。',
            default: true,
          },
          powershellPath: {
            type: 'file',
            title: 'PowerShell 路径',
            description: 'PowerShell 可执行文件路径。留空时自动检测。',
            placeholder: '自动检测',
          },
          defaultTimeoutMs: {
            type: 'number',
            title: '前台命令等待时长（毫秒）',
            description: '前台 bash 的固定预算：预算内完成直接返回；超过则不打断进程，自动转后台任务继续运行。对模型不可见、不可调。',
            default: DEFAULT_TIMEOUT_MS,
            min: 1000,
            max: 600000,
            step: 1000,
          },
        },
      },
    };
  }

  private resolveShellConfig(featureConfig: unknown): ResolvedShellConfig {
    if (!featureConfig || typeof featureConfig !== 'object') {
      return {
        bashEnabled: true,
        powershellEnabled: true,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      };
    }
    const c = featureConfig as Record<string, unknown>;
    return {
      bashEnabled: c.bashEnabled !== false,
      bashPath: typeof c.bashPath === 'string' && c.bashPath.trim() ? c.bashPath.trim() : undefined,
      powershellEnabled: c.powershellEnabled !== false,
      powershellPath: typeof c.powershellPath === 'string' && c.powershellPath.trim() ? c.powershellPath.trim() : undefined,
      defaultTimeoutMs: resolvePositiveNumber(c.defaultTimeoutMs, DEFAULT_TIMEOUT_MS),
    };
  }

  /**
   * 后台登记表惰性初始化（getAsyncTools 才有 agentId）。
   * 进程级共享（key = agentId::workdir）：后台 bash 进程是 OS 级资源，
   * 独立于会话活着；任务表挂在 agent 实例上的话，会话切换 / 新会话的
   * 实例会拿到一张空表，面板与 bg_status 都看不到仍在跑的任务。同进程
   * 的多会话实例复用同一张表，并把自己的 bgObserver 追加进去（各会话
   * 通道都能收到实时事件）。workdir 参与 key，不同测试的 tmpdir 天然隔离。
   * 通知投递邮箱仍归属首个建表的 agent 实例（既有行为，不变）。
   */
  private static readonly sharedRegistries = new Map<string, BgRegistry>();

  private ensureRegistry(agentId: string): BgRegistry {
    if (!this._registry) {
      const key = `${agentId}::${this.workdir}`;
      const shared = ShellFeature.sharedRegistries.get(key);
      if (shared) {
        this._registry = shared;
        // 收养即更新归属锚点：后续登记的任务盖戳本实例会话；
        // 已登记任务保持登记时刻的归属事实不变。
        shared.setSessionId(this.sessionId);
        if (this.bgObserver) shared.addObserver(this.bgObserver);
      } else {
        this._registry = new BgRegistry({ agentId, ...(this.sessionId ? { sessionId: this.sessionId } : {}), ...(this.bgObserver ? { observer: this.bgObserver } : {}) });
        ShellFeature.sharedRegistries.set(key, this._registry);
      }
    }
    return this._registry;
  }

  /**
   * 获取异步工具（bash/powershell 工具，条件注册）
   */
  async getAsyncTools(ctx: FeatureInitContext): Promise<Tool[]> {
    const config = this.resolveShellConfig(ctx.featureConfig);
    const tools: Tool[] = [];

    // ── Bash 工具（前台）+ 后台任务工具族 ──
    if (config.bashEnabled) {
      const bashPath = findGitBashPath(config.bashPath);
      if (bashPath) {
        if (!this.bashDescription) {
          try {
            const descriptionPath = resolve(this.resourceRoot, '.agentdev/prompts/tool-bash.md');
            this.bashDescription = await readFile(descriptionPath, 'utf-8');
          } catch {
            this.bashDescription = '执行短时、需要立即查看结果的前台 Bash 命令。预期长时间运行的任务请使用 bash_bg。';
          }
        }
        const registry = this.ensureRegistry(ctx.agentId);
        tools.push(createShellCommandTool(this.bashDescription, {
          workspaceDir: this.workspaceDir,
          workdir: this.workdir,
          resourceRoot: this.resourceRoot,
          bashPath,
          timeoutMs: config.defaultTimeoutMs,
          registry,
        }));
        // 后台工具族：描述文件优先，缺失时回退内联完整教学文案（防轮询协议
        // 声明不能依赖 resourceRoot 恰好可解析）。
        if (!this.bashBgDescription) {
          try {
            const descriptionPath = resolve(this.resourceRoot, '.agentdev/prompts/tool-bash-bg.md');
            this.bashBgDescription = await readFile(descriptionPath, 'utf-8');
          } catch {
            this.bashBgDescription = BASH_BG_INLINE_DESCRIPTION;
          }
        }
        const spawnOpts = {
          workdir: this.workdir,
          bashPath,
          resourceRoot: this.resourceRoot,
          registry,
        };
        tools.push(createBashBgTool(this.bashBgDescription, spawnOpts));
        tools.push(createBgListTool(registry));
        tools.push(createBgStatusTool(registry));
        tools.push(createBgWaitTool(registry));
        tools.push(createBgTuneTool(registry));
        tools.push(createBgWriteTool(registry));
        tools.push(createBgKillTool(registry));
      } else {
        console.warn('[shell] Bash is enabled but was not found on this system. Skipping Bash tool.');
      }
    }

    // ── PowerShell 工具（前台语义保持现状：可调 timeout、超时打断） ──
    if (config.powershellEnabled) {
      const psPath = findPowerShellPath(config.powershellPath);
      if (psPath) {
        if (!this.powershellDescription) {
          try {
            const descriptionPath = resolve(this.resourceRoot, '.agentdev/prompts/tool-powershell.md');
            this.powershellDescription = await readFile(descriptionPath, 'utf-8');
          } catch {
            this.powershellDescription = '执行 PowerShell 命令';
          }
        }
        tools.push(createPowerShellTool(this.powershellDescription, {
          workspaceDir: this.workspaceDir,
          workdir: this.workdir,
          resourceRoot: this.resourceRoot,
          psPath,
        }));
      } else {
        console.warn('[shell] PowerShell is enabled but was not found on this system. Skipping PowerShell tool.');
      }
    }

    return tools;
  }

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   */
  getTemplateNames(): string[] {
    return [
      'bash',
      'bg',
      'bg-list',
      'bg-status',
      'trash-delete',
      'trash-list',
      'trash-restore',
    ];
  }
}

// 导出工具创建函数（供高级用户使用）
export { createShellCommandTool, runShellCommand, findGitBashPath } from './tools.js';
export type { ShellCommandToolOptions, ShellExecutionResult } from './tools.js';

// 导出后台任务核心与工具族（供高级用户与测试使用）
export {
  BgRegistry,
  FOREGROUND_BUDGET_DEFAULT_MS,
  BG_MIN_INTERVAL_MS,
  BG_MIN_QUIET_MS,
  BG_CAPTURE_WINDOW_MS,
  BG_WAIT_MAX_MS,
  buildBashInvocation,
  cleanBashStderr,
  fmtDur,
  formatForegroundOutput,
  runForegroundWithBudget,
  spawnBackgroundProcess,
} from './bg-core.js';
export type {
  BgTaskPace,
  BgTaskSnapshot,
  BgRegisterOptions,
  BgSpawnOptions,
  BgTaskStatus,
  BgTask,
  BgObserver,
  BgObserverEvent,
  ForegroundOutcome,
} from './bg-core.js';
export {
  BASH_BG_INLINE_DESCRIPTION,
  createBashBgTool,
  createBgKillTool,
  createBgListTool,
  createBgStatusTool,
  createBgTuneTool,
  createBgWaitTool,
  createBgWriteTool,
} from './bg-tools.js';
export { createPowerShellTool, runPowerShellCommand, findPowerShellPath } from './powershell.js';

// 导出共享运行核心（供高级用户使用；截断落盘函数自 tools.ts 迁入，行为不变）
export {
  processOutputWithPersistence,
  formatShellMetadata,
  SHELL_METADATA_OPEN,
  SHELL_METADATA_CLOSE,
} from './shell-core.js';
export type {
  ShellRunResult,
  ShellMetadataFields,
} from './shell-core.js';

// 导出命令引用工具（供高级用户使用）
export {
  quoteShellCommand,
  shouldAddStdinRedirect,
  rewriteWindowsNullRedirect,
  containsHeredoc,
  hasStdinRedirect,
} from './shellQuoting.js';
export {
  safeTrashDeleteTool,
  safeTrashListTool,
  safeTrashRestoreTool,
  createSafeTrashDeleteTool,
  createSafeTrashListTool,
  createSafeTrashRestoreTool,
} from './tools-trash.js';

// 导出库函数（供高级用户使用）
export { safeRm, listTrashed, restore } from './lib/index.js';

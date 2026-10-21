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
  StepFinishDecisionContext,
  DecisionResult,
  PendingWorkHost,
} from '@agentdevjs/core';
import { BackgroundAccess, CoreLifecycle, Decision, getPackageInfoFromSource } from '@agentdevjs/core';
import { createShellCommandTool, findGitBashPath } from './tools.js';
import { createPowerShellTool, findPowerShellPath } from './powershell.js';
import { createSafeTrashDeleteTool, createSafeTrashListTool, createSafeTrashRestoreTool } from './tools-trash.js';
import { BgRegistry, BG_AGGREGATION_WINDOW_MS, FOREGROUND_BUDGET_DEFAULT_MS, createViewerUserTurnDeliver } from './bg-core.js';
import type { BgObserver, BgTask } from './bg-core.js';
import {
  BASH_BG_INLINE_DESCRIPTION,
  createBashBgTool,
  createBgKillTool,
  createBgListTool,
  createBgStatusTool,
  createBgTuneTool,
  createBgWatchTool,
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
   * bg_tune(then="standby") / bg_watch 在消费当轮登记一次性待命请求，读即
   * 消费后结束回合：待命与订阅不占工具调用，由通知推送（节拍/静默/终态
   * 同一管线）唤醒。旧的关键词订阅持续产生通知但不驱动流程决策；待命为
   * 一次性请求，CallStart 清理残留，防止极端路径误伤后续回合。
   */
  static hooks: HookDeclarations = {
    endTurnOnStandby: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
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
  /** 后台任务登记表（首次 getAsyncTools 时按 agentId::workdir 惰性创建/收养）。 */
  private _registry: BgRegistry | null = null;
  /** 通用后台接入（core，ADR-0031）：每实例一份，pending 申报/待命/通知衔接。 */
  private _access: BackgroundAccess | null = null;

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

  /** 通用后台接入（惰性创建前为 null）。宿主集成面：测试与高级装配检查。 */
  getBackgroundAccess(): BackgroundAccess | null {
    return this._access;
  }

  async onDestroy(): Promise<void> {
    if (this._registry && this.bgObserver) this._registry.removeObserver(this.bgObserver);
    // 只释放观察资源：agent 申报回调失效 + 待命意图清除。共享任务表上的
    // 任务仍持有各自归属的 access（未送达事实与补取路径保留），业务进程
    // 不 kill——后台 bash 是 OS 级资源，独立于会话活着。
    this._access?.dispose();
    this._access = null;
    this._registry = null;
  }

  /**
   * StepFinish guard（advisor）：消费本回合显式登记的一次性待命请求
   * （bg_tune then="standby" / bg_watch 订阅即停，经任务归属的
   * BackgroundAccess）时结束当前 call（Decision.Deny 在 react-loop 的
   * 既有语义），把等待交给通知推送——任务终态则终态通知先行，否则节拍/
   * 静默/命中唤醒。待命意图读即消费，CallStart 已清残留；旧的关键词
   * 订阅持续产生通知但不再驱动流程决策——用户插话的新轮次不会被
   * 未命中的旧 watch 误停。无待命意图时一律 Continue。
   */
  async endTurnOnStandby(_ctx: StepFinishDecisionContext): Promise<DecisionResult> {
    return this._access?.consumeStandbyRequest() ? Decision.Deny : Decision.Continue;
  }

  /**
   * CallStart（observe）：清理上一回合可能残留的待命请求（guard 未被咨询
   * 的极端路径），并向 agent 申报 pending-work provider（ADR-0019）。
   *
   * 申报经任务归属的 BackgroundAccess（core 通用后台接入，注册 key 实例
   * 唯一，与其他接入互不覆盖）：本实例登记的未释放工作映射为
   * PendingWakeup（source 恒为 'shell'）。access 尚未创建（本实例还没装配
   * 过 bash 工具）时无事可申报，不注册。已有接入时要求宿主具备
   * pending-work 注册契约，不能静默漏报挂起事实。
   */
  registerPendingWorkOnCallStart(ctx: CallStartContext): void {
    // 清理上一回合可能残留的待命请求（guard 未被咨询的极端路径），防止
    // 误伤本回合。
    this._access?.consumeStandbyRequest();
    if (!this._access) return;
    const agent = ctx.agent as PendingWorkHost | undefined;
    if (typeof agent?.registerPendingWorkProvider !== 'function') {
      throw new Error('[shell] 后台接入要求宿主提供 registerPendingWorkProvider');
    }
    this._access.attachAgent(agent);
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
   *
   * 任务归属会话不再由表级锚点决定（可被收养实例改写）：登记时经各实例
   * 自己的 BackgroundAccess 盖戳捕获（ADR-0031 修复 5），pending 申报、
   * 待命意图与通知分组全部按归属实例隔离，互不串扰。
   */
  private static readonly sharedRegistries = new Map<string, BgRegistry>();

  private ensureRegistry(agentId: string): BgRegistry {
    if (!this._registry) {
      const key = `${agentId}::${this.workdir}`;
      const shared = ShellFeature.sharedRegistries.get(key);
      if (shared) {
        this._registry = shared;
        if (this.bgObserver) shared.addObserver(this.bgObserver);
      } else {
        this._registry = new BgRegistry(this.bgObserver ? { observer: this.bgObserver } : {});
        ShellFeature.sharedRegistries.set(key, this._registry);
      }
    }
    return this._registry;
  }

  /**
   * 通用后台接入惰性初始化（与登记表同刻创建）：HTTP 投递适配器锚定本
   * agentId；聚合窗口沿用 Bash 策略值。通知事件身份（eventId，网关幂等键）
   * 与工作身份（workIds）在 core 通用层生成/分组，适配器只做映射。
   * 工作释放联动共享表的终态裁剪（通知送达前裁剪条件不成立，见 trimDone）。
   */
  private ensureAccess(agentId: string, registry: BgRegistry): BackgroundAccess {
    if (!this._access) {
      this._access = new BackgroundAccess({
        source: 'shell',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        deliver: createViewerUserTurnDeliver(agentId),
        aggregationWindowMs: BG_AGGREGATION_WINDOW_MS,
        onWorkRelease: () => registry.trimDone(),
      });
    }
    return this._access;
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
        const access = this.ensureAccess(ctx.agentId, registry);
        tools.push(createShellCommandTool(this.bashDescription, {
          workspaceDir: this.workspaceDir,
          workdir: this.workdir,
          resourceRoot: this.resourceRoot,
          bashPath,
          timeoutMs: config.defaultTimeoutMs,
          registry,
          access,
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
          access,
        };
        tools.push(createBashBgTool(this.bashBgDescription, spawnOpts));
        tools.push(createBgListTool(registry));
        tools.push(createBgStatusTool(registry));
        tools.push(createBgWatchTool(registry, access));
        tools.push(createBgTuneTool(registry, access));
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
  BG_AGGREGATION_WINDOW_MS,
  FOREGROUND_BUDGET_DEFAULT_MS,
  BG_MIN_INTERVAL_MS,
  BG_MIN_QUIET_MS,
  BG_CAPTURE_WINDOW_MS,
  BG_WATCH_MAX_CHARS,
  buildBashInvocation,
  cleanBashStderr,
  createViewerUserTurnDeliver,
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
  createBgWatchTool,
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

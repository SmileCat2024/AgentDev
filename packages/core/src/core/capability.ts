/**
 * Capability System - 统一能力控制面（P1：command）
 *
 * Feature 通过 getCapabilities() 声明可被显式调用的命令，注册表提供
 * 平面寻址（`featureName.commandName`）与三动词中的 invoke 语义。
 *
 * 设计裁决（详见 AgentDevClaw docs/adr capability-registry-as-control-plane）：
 * - 命令式优先：只有 invoke / query / emit，不存在 bind / reactive / watch。
 *   共享权威状态与跨 feature 事务是负面清单，不做。
 * - entryPoints 是契约约束而非安全边界：声明不含请求入口的 command 被
 *   invoke 时返回 entry_point_denied（结构化错误，非静默失败）。绕过
 *   路径（getFeature 直引）依旧存在，这是已知边界而非漏洞。
 * - 进程内语义：args 是普通 JS 值，不为序列化设计。跨进程投递是宿主层
 *   职责，注册表不为其建模。
 * - 注册表是哑的：不做参数校验（schema 服务于消费端渲染表单）、不含
 *   派发策略、不管依赖管理。
 * - 命令超时即失败：超时返回 timeout，但执行体可能仍在进行（Promise
 *   无法取消），不保证中断，只保证调用方不挂死。
 */

import type { AgentFeature, FeatureManifestSettingProperty } from './feature.js';
import type { Logger } from './logging.js';

/**
 * 能力入口类型
 *
 * - 'slash'：出现在用户命令菜单（宿主下发清单时过滤）
 * - 'feature'：可被其他 feature（或经宿主转发的等价调用）invoke
 */
export type CapabilityEntryPoint = 'slash' | 'feature';

/**
 * 命令类型。框架层仅定义形状并透传——两种 kind 在框架眼里同质
 * （收到 invoke 一律执行 execute）；行为差异（表单/pill/toast/触发
 * 时机）由应用层（宿主前端）按 kind 消费。
 *
 * - invoke（缺省）：选中即执行的触发型命令（配置开关等）
 * - prompt：调用指令以文本形式嵌入输入的命令（skill 等），
 *   应用层负责其呈现与发送时机，feature 在自身生命周期内消费
 */
export type CapabilityKind = 'invoke' | 'prompt';

/**
 * Feature 声明的可调用命令
 */
export interface CapabilityDefinition {
  /** 命令名（标识符），注册表内以 `featureName.commandName` 寻址 */
  name: string;
  /** 命令类型，缺省 'invoke'。框架透传不解释，语义由应用层消费 */
  kind?: CapabilityKind;
  /** 菜单显示标题，缺省用 name */
  title?: string;
  /** 菜单描述 */
  description?: string;
  /**
   * 参数 schema，复用 FeatureManifestSettingProperty 词汇表，
   * 与 feature-setup 配置表单、flow 交互选项共用一套渲染基底。
   */
  parameters?: Record<string, FeatureManifestSettingProperty>;
  /**
   * 可见入口，缺省 ['feature']（最小暴露）。
   * 进 slash 菜单必须是显式主动行为。
   */
  entryPoints?: CapabilityEntryPoint[];
  /**
   * 参数当前生效值（配置回显）：参数表单打开时优先于 parameters 的
   * default 显示。返回普通对象，键与 parameters 对齐；缺省或抛错
   * 时表单回退 default。读取必须无副作用。
   */
  readCurrentValues?: () => Record<string, unknown>;
  /** 执行体。抛出的任何错误归一为 execute_failed */
  execute(args: Record<string, unknown>, ctx: CapabilityContext): Promise<unknown>;
}

/**
 * 命令执行上下文（进程内）
 */
export interface CapabilityContext {
  agentId: string;
  getFeature<T extends AgentFeature>(name: string): T | undefined;
  logger: Logger;
}

/**
 * invoke 的结构化结果。错误码是稳定契约：
 * - not_found：ref 未注册
 * - entry_point_denied：该入口不在 entryPoints 中
 * - execute_failed：执行体抛错
 * - timeout：超过时限（执行体不保证被取消）
 */
export type CapabilityInvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; code: 'not_found' | 'entry_point_denied' | 'execute_failed' | 'timeout'; message: string };

/**
 * 清单快照条目（下发宿主 / 前端菜单消费的数据形态，纯数据）
 */
export interface CapabilitySnapshot {
  feature: string;
  name: string;
  ref: string;
  /** 命令类型（缺省 'invoke'），透传给应用层消费 */
  kind: CapabilityKind;
  title: string;
  description?: string;
  parameters?: Record<string, FeatureManifestSettingProperty>;
  entryPoints: CapabilityEntryPoint[];
  /** 参数当前生效值（readCurrentValues 收集；读取失败时缺省） */
  currentValues?: Record<string, unknown>;
}

const NAME_PATTERN = /^[a-zA-Z][\w-]*$/;
const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeEntryPoints(entryPoints?: CapabilityEntryPoint[]): CapabilityEntryPoint[] {
  return entryPoints && entryPoints.length > 0 ? entryPoints : ['feature'];
}

/**
 * 能力注册表（per-Agent 实例）
 */
export class CapabilityRegistry {
  private defs = new Map<string, { feature: string; def: CapabilityDefinition }>();

  /**
   * 注册 feature 的命令。ref（`feature.name`）重复视为装配错误，直接抛出，
   * 对齐 feature-graph 的报错哲学。
   */
  register(featureName: string, def: CapabilityDefinition): void {
    if (!NAME_PATTERN.test(def.name)) {
      throw new Error(`[capability] invalid command name "${def.name}" (must match ${NAME_PATTERN})`);
    }
    if (NAME_PATTERN.test(featureName) === false) {
      throw new Error(`[capability] invalid feature name "${featureName}"`);
    }
    const ref = `${featureName}.${def.name}`;
    if (this.defs.has(ref)) {
      throw new Error(`[capability] duplicate capability ref "${ref}"`);
    }
    this.defs.set(ref, { feature: featureName, def });
  }

  has(ref: string): boolean {
    return this.defs.has(ref);
  }

  /** ref → 所属 feature 名（dispatchTurnActivations 按 owner 分组派发用） */
  ownerOf(ref: string): string | null {
    return this.defs.get(ref)?.feature ?? null;
  }

  /** ref → 命令类型（缺省 'invoke'）；未注册返回 null */
  kindOf(ref: string): CapabilityKind | null {
    const entry = this.defs.get(ref);
    return entry ? (entry.def.kind ?? 'invoke') : null;
  }

  /**
   * 移除指定 feature 的全部命令（幂等）。
   * initSingleFeature 重挂路径先调它，避免热载时误报 duplicate ref。
   */
  unregisterFeature(featureName: string): void {
    for (const [ref, entry] of this.defs) {
      if (entry.feature === featureName) this.defs.delete(ref);
    }
  }

  /**
   * 清单快照。传入 entryPoint 时过滤出该入口可见的命令
   * （宿主下发 slash 菜单清单时用 { entryPoint: 'slash' }）。
   */
  list(filter?: { entryPoint?: CapabilityEntryPoint }): CapabilitySnapshot[] {
    const snapshots: CapabilitySnapshot[] = [];
    for (const { feature, def } of this.defs.values()) {
      const entryPoints = normalizeEntryPoints(def.entryPoints);
      if (filter?.entryPoint && !entryPoints.includes(filter.entryPoint)) continue;
      let currentValues: Record<string, unknown> | undefined;
      if (typeof def.readCurrentValues === 'function') {
        try {
          const values = def.readCurrentValues();
          if (values && typeof values === 'object') currentValues = values;
        } catch {
          // 回显失败不影响清单下发，表单回退 default
        }
      }
      snapshots.push({
        feature,
        name: def.name,
        ref: `${feature}.${def.name}`,
        kind: def.kind ?? 'invoke',
        title: def.title ?? def.name,
        description: def.description,
        parameters: def.parameters,
        entryPoints,
        currentValues,
      });
    }
    return snapshots;
  }

  /**
   * 调用命令。entryPoint 必填——调用方声明自己以哪个入口进来，
   * 注册表据此执行 entryPoints 契约检查。
   */
  async invoke(
    ref: string,
    opts: { args?: Record<string, unknown>; entryPoint: CapabilityEntryPoint; timeoutMs?: number },
    ctx: CapabilityContext,
  ): Promise<CapabilityInvokeResult> {
    const entry = this.defs.get(ref);
    if (!entry) {
      return { ok: false, code: 'not_found', message: `capability "${ref}" is not registered` };
    }
    const entryPoints = normalizeEntryPoints(entry.def.entryPoints);
    if (!entryPoints.includes(opts.entryPoint)) {
      return {
        ok: false,
        code: 'entry_point_denied',
        message: `capability "${ref}" does not accept entry point "${opts.entryPoint}" (declared: [${entryPoints.join(', ')}])`,
      };
    }
    const args = opts.args ?? {};
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        entry.def.execute(args, ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('__capability_timeout__')), timeoutMs);
        }),
      ]);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === '__capability_timeout__') {
        return { ok: false, code: 'timeout', message: `capability "${ref}" timed out after ${timeoutMs}ms` };
      }
      return { ok: false, code: 'execute_failed', message };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

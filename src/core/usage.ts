/**
 * UsageStats - 用量统计系统
 *
 * 职责：
 * - 记录 LLM 调用的 token 用量
 * - 聚合 session/call/step 三级统计
 * - 提供快照序列化和恢复
 * - 格式化用量报告
 *
 * 设计原则：
 * - 框架内置，不是 Feature
 * - 自动收集，不需要手动干预
 * - 快照包含 session 级数据，用于会话恢复
 */

/**
 * 统一用量格式（兼容 Anthropic 和 OpenAI）
 */
export interface UsageInfo {
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 总 token 数 */
  totalTokens: number;

  // ========== Anthropic 特有（可选）==========
  /** 创建缓存消耗的 token 数 */
  cacheCreationTokens?: number;
  /** 从缓存读取的 token 数 */
  cacheReadTokens?: number;

  // ========== OpenAI 特有（可选）==========
  /** 推理 token 数（prompt_tokens_details 或 completion_tokens_details） */
  reasoningTokens?: number;
  /** 音频 token 数 */
  audioTokens?: number;
}

/**
 * 单步用量记录
 */
interface StepUsageRecord {
  callIndex: number;
  step: number;
  usage: UsageInfo;
  timestamp: number;
}

/**
 * 单次 Call 用量汇总
 */
export interface CallUsageSummary {
  callIndex: number;
  totalUsage: UsageInfo;
  stepCount: number;
  cacheHitRequests: number;
  startTime: number;
  endTime?: number;
}

/**
 * Session 用量快照（用于序列化）
 */
export interface UsageStatsSnapshot {
  /** Session 级累计用量 */
  totalUsage: UsageInfo;
  /** 各 Call 的用量汇总 */
  calls: CallUsageSummary[];
  /** 总请求数（LLM 调用次数） */
  totalRequests: number;
  /** 命中缓存的请求数（request-level） */
  totalCacheHitRequests: number;
}

/**
 * 用量统计类
 */
export class UsageStats {
  /** Session 级累计用量 */
  private totalUsage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  /** 当前活跃 Call 的用量记录 */
  private currentCallUsage: Map<number, CallUsageSummary> = new Map();

  /** 总 LLM 调用次数 */
  private totalRequests: number = 0;

  /** 命中缓存的总请求数 */
  private totalCacheHitRequests: number = 0;

  /** 当前 Call 的 Step 记录（临时，用于聚合） */
  private currentStepRecords: StepUsageRecord[] = [];

  /**
   * 记录一次 LLM 调用的用量
   * @param callIndex Call 序号
   * @param step Step 序号
   * @param usage 用量数据
   */
  record(callIndex: number, step: number, usage: UsageInfo): void {
    // 累加到总计
    this.totalUsage.inputTokens += usage.inputTokens;
    this.totalUsage.outputTokens += usage.outputTokens;
    this.totalUsage.totalTokens += usage.totalTokens;

    // 累加可选字段
    if (usage.cacheCreationTokens) {
      this.totalUsage.cacheCreationTokens = (this.totalUsage.cacheCreationTokens || 0) + usage.cacheCreationTokens;
    }
    if (usage.cacheReadTokens) {
      this.totalUsage.cacheReadTokens = (this.totalUsage.cacheReadTokens || 0) + usage.cacheReadTokens;
    }
    if (usage.reasoningTokens) {
      this.totalUsage.reasoningTokens = (this.totalUsage.reasoningTokens || 0) + usage.reasoningTokens;
    }
    if (usage.audioTokens) {
      this.totalUsage.audioTokens = (this.totalUsage.audioTokens || 0) + usage.audioTokens;
    }

    // 记录 Step
    this.currentStepRecords.push({
      callIndex,
      step,
      usage,
      timestamp: Date.now(),
    });

    this.totalRequests++;

    // 更新当前 Call 的汇总
    let callSummary = this.currentCallUsage.get(callIndex);
    if (!callSummary) {
      callSummary = {
        callIndex,
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stepCount: 0,
        cacheHitRequests: 0,
        startTime: Date.now(),
      };
      this.currentCallUsage.set(callIndex, callSummary);
    }

    callSummary.totalUsage.inputTokens += usage.inputTokens;
    callSummary.totalUsage.outputTokens += usage.outputTokens;
    callSummary.totalUsage.totalTokens += usage.totalTokens;
    callSummary.stepCount++;

    // 累加可选字段到 Call 级
    if (usage.cacheCreationTokens) {
      callSummary.totalUsage.cacheCreationTokens = (callSummary.totalUsage.cacheCreationTokens || 0) + usage.cacheCreationTokens;
    }
    if (usage.cacheReadTokens) {
      callSummary.totalUsage.cacheReadTokens = (callSummary.totalUsage.cacheReadTokens || 0) + usage.cacheReadTokens;
      callSummary.cacheHitRequests++;
      this.totalCacheHitRequests++;
    }
    if (usage.reasoningTokens) {
      callSummary.totalUsage.reasoningTokens = (callSummary.totalUsage.reasoningTokens || 0) + usage.reasoningTokens;
    }
    if (usage.audioTokens) {
      callSummary.totalUsage.audioTokens = (callSummary.totalUsage.audioTokens || 0) + usage.audioTokens;
    }
  }

  /**
   * 标记 Call 结束
   * @param callIndex Call 序号
   */
  endCall(callIndex: number): void {
    const callSummary = this.currentCallUsage.get(callIndex);
    if (callSummary) {
      callSummary.endTime = Date.now();
    }
  }

  /**
   * 获取 Session 级累计用量
   */
  getTotalUsage(): UsageInfo {
    return { ...this.totalUsage };
  }

  /**
   * 获取指定 Call 的用量汇总
   * @param callIndex Call 序号
   */
  getCallUsage(callIndex: number): CallUsageSummary | undefined {
    const summary = this.currentCallUsage.get(callIndex);
    return summary ? { ...summary } : undefined;
  }

  /**
   * 获取所有 Call 的用量汇总
   */
  getAllCallUsage(): CallUsageSummary[] {
    return Array.from(this.currentCallUsage.values()).map(s => ({ ...s }));
  }

  /**
   * 获取总请求次数
   */
  getTotalRequests(): number {
    return this.totalRequests;
  }

  getTotalCacheHitRequests(): number {
    return this.totalCacheHitRequests;
  }

  /**
   * 获取格式化的用量报告
   */
  getReport(): string {
    const u = this.totalUsage;
    const parts = [
      `Total: ${u.totalTokens.toLocaleString()} tokens`,
      `  Input: ${u.inputTokens.toLocaleString()}`,
      `  Output: ${u.outputTokens.toLocaleString()}`,
    ];

    if (u.cacheCreationTokens || u.cacheReadTokens) {
      parts.push(
        `  Cache Read: ${u.cacheReadTokens?.toLocaleString() || 0}`,
        `  Cache Creation: ${u.cacheCreationTokens?.toLocaleString() || 0}`
      );
    }

    if (u.reasoningTokens) {
      parts.push(`  Reasoning: ${u.reasoningTokens.toLocaleString()}`);
    }

    parts.push(`Requests: ${this.totalRequests.toLocaleString()}`);

    return parts.join('\n');
  }

  /**
   * 创建快照（用于序列化）
   */
  toSnapshot(): UsageStatsSnapshot {
    return {
      totalUsage: { ...this.totalUsage },
      calls: this.getAllCallUsage(),
      totalRequests: this.totalRequests,
      totalCacheHitRequests: this.totalCacheHitRequests,
    };
  }

  /**
   * 从快照恢复
   */
  fromSnapshot(snapshot: UsageStatsSnapshot): void {
    this.totalUsage = { ...snapshot.totalUsage };
    this.totalRequests = snapshot.totalRequests;
    this.totalCacheHitRequests = snapshot.totalCacheHitRequests ?? 0;
    this.currentCallUsage.clear();
    for (const call of snapshot.calls) {
      this.currentCallUsage.set(call.callIndex, { ...call });
    }
    // Step 记录不恢复，因为它是临时的中间数据
    this.currentStepRecords = [];
  }

  /**
   * 重置统计（谨慎使用）
   */
  reset(): void {
    this.totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this.currentCallUsage.clear();
    this.currentStepRecords = [];
    this.totalRequests = 0;
    this.totalCacheHitRequests = 0;
  }
}

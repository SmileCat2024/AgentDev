/**
 * LLM 适配器重试可观测性
 *
 * 单次模型请求内部的重试过程通知。与执行控制流解耦：
 * 通知发射失败（无 notification scope / 模块不可用）不影响重试本身。
 */

import { classifyAPIError } from './api-errors.js';
import type { LLMRetryData } from '../core/notification.js';

/**
 * 在适配器重试点发射 llm.retry 通知（waiting → sleep → requesting）。
 *
 * sleep 接受 AbortSignal：用户中断会同时取消退避等待并向上传播 AbortError。
 */
export async function emitRetryObservability(params: {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  signal?: AbortSignal;
  error: unknown;
  status?: number;
}): Promise<void> {
  const { attempt, maxRetries, delayMs, signal, error, status } = params;
  const base: LLMRetryData = {
    attempt,
    maxRetries,
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(status !== undefined ? { statusCode: status } : {}),
    errorType: classifyAPIError(error, status),
  };
  await emitRetryNotification({ ...base, phase: 'waiting' });
  await sleepQuietly(delayMs, signal);
  await emitRetryNotification({ ...base, phase: 'requesting' });
}

async function emitRetryNotification(data: LLMRetryData): Promise<void> {
  try {
    // 动态导入避免 llm → core 的静态依赖加重；模块缓存后开销可忽略
    const { emitNotification, createLLMRetry } = await import('../core/notification.js');
    emitNotification(createLLMRetry(data));
  } catch {
    // 通知失败不影响重试
  }
}

async function sleepQuietly(ms: number, signal?: AbortSignal): Promise<void> {
  const { sleep } = await import('./retry.js');
  await sleep(ms, signal);
}

/**
 * CI 环境 stub — 当本地 @sliverp/qqbot 不可用时提供最小占位实现。
 * 仅用于 typecheck 和 test 运行，不提供真实 QQ Bot 功能。
 */

export interface ResolvedQQBotAccount {
  accountId: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  secretSource: string;
  markdownSupport: boolean;
  config: Record<string, unknown>;
}

export interface QQBotInboundRequest {
  text: string;
  [key: string]: unknown;
}

export interface OutboundResult {
  text?: string;
  [key: string]: unknown;
}

export function createQQBotAgentAdapter(
  _handler: (request: QQBotInboundRequest) => Promise<OutboundResult>
): unknown {
  return {};
}

export function startGateway(_options: Record<string, unknown>): Promise<void> {
  return Promise.resolve();
}

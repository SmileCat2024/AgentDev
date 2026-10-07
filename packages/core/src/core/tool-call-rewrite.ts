/**
 * Utility for tools to declare the effective call that actually executed
 * (ADR-0023: tool call history rewrite).
 *
 * A tool whose `Tool.rewritable` is `true` calls {@link withRewrite} in its
 * `execute()` function to declare "the call that actually took effect". The
 * framework validates the declaration (id unchanged, tool declared rewritable,
 * target tool registered) and then replaces the matching toolCall in the
 * assistant history — so the next LLM turn sees the effective call as if the
 * model had made it. The original call is preserved in structured logs
 * (`tool.rewrite` event) and in `display.rewrittenCall` for frontend audit.
 *
 * The rewrite is only meaningful for successful executions: a thrown error
 * cannot carry a rewrite (there is no effective execution to record).
 */

import type { ToolCall } from './types.js';

const TOOL_REWRITE_MARKER = '__withRewrite';

/**
 * Structured return shape recognized by the tool-executor.
 * Tools should not construct this object manually — use {@link withRewrite} instead.
 */
export interface WithRewriteResult {
  /** Marker field — always `true`. Do not set manually. */
  readonly __withRewrite: true;
  /** Result text returned to the LLM as the normal tool output. */
  readonly text: string;
  /** The call that actually took effect. `id` must equal the original call's id. */
  readonly effectiveCall: ToolCall;
  /** Optional display data for frontend rendering (same channel as withDisplay). */
  readonly display?: unknown;
}

/**
 * Wrap a successful result with the effective call declaration, so the
 * framework rewrites the assistant history to the effective call (ADR-0023).
 *
 * @example
 * ```ts
 * execute: async (args) => {
 *   const normalized = { ...args, path: resolve(args.path) };
 *   const content = readFile(normalized.path);
 *   return withRewrite(
 *     JSON.stringify({ path: normalized.path, size: content.length }),
 *     { id: currentCallId, name: 'read_file', arguments: normalized },
 *   );
 * }
 * ```
 *
 * The returned object is recognized by the tool-executor via the
 * `__withRewrite` marker. Validation failures (tool not declared `rewritable`,
 * id mismatch, target tool not registered) are framework errors: the rewrite is
 * abandoned and the history keeps the original call.
 */
export function withRewrite(text: string, effectiveCall: ToolCall, display?: unknown): WithRewriteResult {
  return { __withRewrite: true, text, effectiveCall, ...(display !== undefined ? { display } : {}) };
}

/**
 * Type guard: does this value carry the `__withRewrite` marker?
 */
export function isWithRewriteResult(data: unknown): data is WithRewriteResult {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>)[TOOL_REWRITE_MARKER] === true
  );
}

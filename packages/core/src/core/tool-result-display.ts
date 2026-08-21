/**
 * Utility for tools to return a display-only payload alongside a compact text result.
 *
 * Tools call {@link withDisplay} in their `execute()` function to declare
 * a split between what the LLM sees (compact `text`) and what the frontend
 * renders (rich `display` data). The tool-executor detects the
 * `__withDisplay` marker and routes the display data into {@link ToolExecResult.display},
 * which is attached to the tool message without being injected into the LLM prompt.
 *
 * The text portion is stored as the normal tool result string (injected into
 * LLM context), while the display data is stored alongside on the message
 * for frontend rendering only.
 */

const TOOL_DISPLAY_MARKER = '__withDisplay';

/**
 * Structured return shape recognized by the tool-executor.
 * Tools should not construct this object manually — use {@link withDisplay} instead.
 */
export interface WithDisplayResult {
  /** Marker field — always `true`. Do not set manually. */
  readonly __withDisplay: true;
  /** Compact text result returned to the LLM as the normal tool output. */
  readonly text: string;
  /** Rich data for frontend rendering only — never injected into LLM context. */
  readonly display: unknown;
}

/**
 * Wrap a compact text result with display data so the framework knows to
 * separate the two: text goes to the LLM, display goes to the frontend.
 *
 * @example
 * ```ts
 * execute: async ({ filePath, content }) => {
 *   // ... write file ...
 *   const diff = createTwoFilesPatch(filePath, filePath, oldContent, content);
 *   return withDisplay(
 *     JSON.stringify({ filePath, existed, message: 'File created successfully' }),
 *     { diff, filePath, existed }
 *   );
 * }
 * ```
 *
 * The returned object is recognized by the tool-executor via the
 * `__withDisplay` marker. Tools that don't need display separation should
 * simply return a normal value (string, object, etc.) — no wrapper needed.
 */
export function withDisplay(text: string, display: unknown): WithDisplayResult {
  return { __withDisplay: true, text, display };
}

/**
 * Type guard: does this value carry the `__withDisplay` marker?
 */
export function isWithDisplayResult(data: unknown): data is WithDisplayResult {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>)[TOOL_DISPLAY_MARKER] === true
  );
}

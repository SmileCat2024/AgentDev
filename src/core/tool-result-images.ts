/**
 * Utility for tools to return images alongside text results.
 *
 * Tools call {@link withImages} in their `execute()` function to declare
 * that the result carries image data. The tool-executor detects the
 * `__withImages` marker and routes the images into {@link ToolExecResult.images},
 * which is then propagated to the tool message in context.
 *
 * The text portion is stored as the normal tool result string, while the
 * images bypass `JSON.stringify` and are attached directly to the message —
 * the LLM compilers handle them per-provider (image blocks for vision models,
 * text placeholders for non-vision models).
 */

import type { ImageInput } from './types.js';

const TOOL_IMAGES_MARKER = '__withImages';

/**
 * Structured return shape recognized by the tool-executor.
 * Tools should not construct this object manually — use {@link withImages} instead.
 */
export interface WithImagesResult {
  /** Marker field — always `true`. Do not set manually. */
  readonly __withImages: true;
  /** Text result returned to the LLM as the normal tool output. */
  readonly text: string;
  /** Images to inject into the conversation context. */
  readonly images: ImageInput[];
}

/**
 * Wrap a text result with images so the framework knows to inject them
 * into the conversation context alongside the tool output.
 *
 * @example
 * ```ts
 * execute: async ({ path }) => {
 *   return withImages(`Read image: ${path}`, [{ path, mediaType: 'image/png', source: path }]);
 * }
 * ```
 *
 * The returned object is recognized by the tool-executor via the
 * `__withImages` marker. Tools that don't need images should simply
 * return a normal value (string, object, etc.) — no wrapper needed.
 */
export function withImages(text: string, images: ImageInput[]): WithImagesResult {
  return { __withImages: true, text, images };
}

/**
 * Type guard: does this value carry the `__withImages` marker?
 */
export function isWithImagesResult(data: unknown): data is WithImagesResult {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>)[TOOL_IMAGES_MARKER] === true
  );
}

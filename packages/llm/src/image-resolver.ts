/**
 * Image data resolver for LLM compilers.
 *
 * Resolves an {@link ImageInput} to base64 data by either:
 * - Reading the inline `base64` field (backward compat with old sessions)
 * - Reading from `path` on disk (preferred, avoids session bloat)
 *
 * Used by compileContextForAnthropic, OpenAILLM, and OpenAIResponsesLLM.
 */

import { readFileSync } from 'node:fs';
import type { ImageInput } from '../core/types.js';

/**
 * Resolve an ImageInput to raw base64 data (no data-URI prefix).
 *
 * Priority: `base64` field → `path` file read.
 * Returns `null` if neither source yields data.
 */
export function resolveImageBase64(img: ImageInput): string | null {
  if (img.base64) return img.base64;
  if (img.path) {
    try {
      const buf = readFileSync(img.path);
      return buf.toString('base64');
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build a data-URI string (e.g. "data:image/png;base64,...") from an ImageInput.
 * Returns `null` if no data can be resolved.
 */
export function resolveImageDataUri(img: ImageInput): string | null {
  const base64 = resolveImageBase64(img);
  if (!base64) return null;
  const mediaType = img.mediaType || 'image/png';
  return `data:${mediaType};base64,${base64}`;
}

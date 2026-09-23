/**
 * Base-URL normalization shared by the LLM adapters.
 *
 * Preset configs are user-entered and sometimes carry the full endpoint path
 * ("https://api.example.com/v1/chat/completions") instead of the API root.
 * The OpenAI SDK appends "/chat/completions" or "/responses" itself, and the
 * Anthropic adapter appends "/v1/messages", so a stored suffix would be
 * duplicated and the request would 404. Strip exactly these terminal
 * suffixes; roots like ".../openai/deployments/gpt-4o" or
 * ".../api/anthropic" are untouched.
 */
const ENDPOINT_SUFFIX_RE = /\/(?:chat\/completions|responses|messages)\/?$/i;

export function stripEndpointSuffixes(url: string): string {
  let normalized = url.trim().replace(/\/+$/, '');
  while (ENDPOINT_SUFFIX_RE.test(normalized)) {
    normalized = normalized.replace(ENDPOINT_SUFFIX_RE, '').replace(/\/+$/, '');
  }
  return normalized;
}

/**
 * Normalize a user-configured baseURL for the OpenAI SDK.
 * Returns undefined for empty input so the SDK keeps its own defaults.
 */
export function normalizeApiBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  return stripEndpointSuffixes(baseUrl) || undefined;
}

/** Resolve the final messages endpoint for the Anthropic wire protocol. */
export function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = stripEndpointSuffixes(baseUrl);
  if (/\/v\d+$/i.test(normalized)) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

/**
 * Tool JSON schema sanitizer shared by LLM adapters.
 *
 * `$schema` is a documentation-only pointer to the JSON Schema dialect
 * (e.g. "https://json-schema.org/draft/2020-12/schema"). It carries no
 * meaning for the model, and some OpenAI/Anthropic-compatible backends
 * choke on it — notably, an internal DeepSeek endpoint silently disables
 * tool use entirely once `$schema` appears in 3+ tool definitions.
 * Strip it recursively before sending schemas over the wire.
 */

export function sanitizeToolSchema(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = parameters && typeof parameters === 'object' ? parameters : { type: 'object', properties: {} };
  return stripSchemaMeta(base) as Record<string, unknown>;
}

function stripSchemaMeta(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripSchemaMeta);
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$schema') continue;
      out[key] = stripSchemaMeta(value);
    }
    return out;
  }
  return node;
}

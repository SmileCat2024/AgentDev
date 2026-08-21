export default function renderExampleTool(data: Record<string, unknown>): string {
  const counter = typeof data.counter === 'number' ? data.counter : 0;
  const lastInput = typeof data.lastInput === 'string' ? data.lastInput : '';
  const enabled = Boolean(data.enabled);
  const notes = Array.isArray(data.notes) ? data.notes : [];

  return [
    '# Example Feature Result',
    `enabled: ${enabled}`,
    `counter: ${counter}`,
    `lastInput: ${lastInput || '(empty)'}`,
    `notes: ${notes.length > 0 ? notes.join(', ') : '(none)'}`,
  ].join('\n');
}

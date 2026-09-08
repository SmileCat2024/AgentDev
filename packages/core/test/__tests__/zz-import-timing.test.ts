import { it, expect } from 'vitest';

it('times dynamic import of @vscode/ripgrep', async () => {
  const t0 = Date.now();
  const mod = await import('@vscode/ripgrep');
  const t1 = Date.now();
  console.log('first import:', t1 - t0, 'ms, rgPath =', typeof mod.rgPath);
  const t2 = Date.now();
  await import('@vscode/ripgrep');
  console.log('second import:', Date.now() - t2, 'ms');
  expect(typeof mod.rgPath).toBe('string');
});

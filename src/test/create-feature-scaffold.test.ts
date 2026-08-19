import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFeatureProject } from '../../packages/create-feature/src/index.js';

describe('create-feature scaffold', () => {
  it('pins the generated development dependency to the supported AgentDev range', async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), 'agentdev-create-feature-'));
    try {
      const created = await createFeatureProject({ featureName: 'compatibility-demo', parentDir });
      const packageJson = JSON.parse(await readFile(path.join(created.targetDir, 'package.json'), 'utf8'));

      expect(packageJson.peerDependencies.agentdev).toBe('^0.2.11');
      expect(packageJson.devDependencies.agentdev).toBe('^0.2.11');
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });
});

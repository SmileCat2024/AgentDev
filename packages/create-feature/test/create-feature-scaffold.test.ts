import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFeatureProject } from '../src/index.js';

describe('create-feature scaffold', () => {
  it('pins the generated development dependency to the supported AgentDev core range', async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), 'agentdev-create-feature-'));
    try {
      const created = await createFeatureProject({ featureName: 'compatibility-demo', parentDir });
      const packageJson = JSON.parse(await readFile(path.join(created.targetDir, 'package.json'), 'utf8'));

      expect(packageJson.peerDependencies['@agentdevjs/core']).toBe('^0.1.0');
      expect(packageJson.devDependencies['@agentdevjs/core']).toBe('^0.1.0');
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });
});

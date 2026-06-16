import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Decision } from '../../../core/lifecycle.js';
import { createEditTool, createWriteTool } from '../tools.js';
import { OpencodeBasicFeature } from '../index.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-opencode-'));
  const targetFile = join(workspaceDir, 'sample.txt');
  const writeTool = createWriteTool(workspaceDir);
  const editTool = createEditTool(workspaceDir);
  const feature = new OpencodeBasicFeature({ workspaceDir });

  try {
    await writeTool.execute({ path: 'sample.txt', content: 'hello' });
    const created = await readFile(targetFile, 'utf8');
    assert(created === 'hello', 'write should accept the path alias');

    await editTool.execute({ filepath: 'sample.txt', oldString: 'hello', newString: 'world' });
    const updated = await readFile(targetFile, 'utf8');
    assert(updated === 'world', 'edit should accept the filepath alias');

    let missingPathError = '';
    try {
      await writeTool.execute({});
    } catch (error) {
      missingPathError = error instanceof Error ? error.message : String(error);
    }
    assert(
      missingPathError === 'Missing required parameter: "filePath". Received an empty object.',
      'write should fail with a clear missing path message'
    );

    await feature.onInitiate({ logger: { info() {}, warn() {} } } as any);
    const readDecision = await feature.validateWriteOperation({
      call: {
        id: 'read_alias',
        name: 'read',
        arguments: { path: 'sample.txt' },
      },
    } as any);
    assert(readDecision === Decision.Continue, 'read hook should accept the path alias');

    const writeDecision = await feature.validateWriteOperation({
      call: {
        id: 'write_alias',
        name: 'write',
        arguments: { filepath: 'sample.txt' },
      },
    } as any);
    assert(writeDecision === Decision.Continue, 'write hook should accept the filepath alias');

    console.log('[PASS] OpencodeBasic path argument compatibility test passed');
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});

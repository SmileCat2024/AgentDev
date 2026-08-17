import { copyFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const source = join(root, 'agentdev-feature.json');
const target = join(root, 'dist', 'agentdev-feature.json');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log('Copied agentdev-feature.json to dist/');

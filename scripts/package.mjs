import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = await readdir('build');
const entries = [];
for (const name of files) {
  const path = join('build', name);
  if (name === 'bridge') continue;
  if ((await stat(path)).isDirectory() || !name.startsWith('.')) entries.push(name);
}
await mkdir('dist', { recursive: true });
await rm('dist/ConfluenceToolkit.zip', { force: true });
const zip = spawnSync('zip', ['-qr', '../dist/ConfluenceToolkit.zip', ...entries], { cwd: 'build', stdio: 'inherit' });
if (zip.error || zip.status !== 0) throw zip.error ?? new Error('Could not create the extension ZIP.');

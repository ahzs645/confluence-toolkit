import { build } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('build/', root);
const ownerPreference = new URL('planner-owner-last.local.txt', root);
const ownerLast = await readFile(ownerPreference, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const define = { __PLANNER_OWNER_LAST__: JSON.stringify(ownerLast.trim()) };

await rm(output, { recursive: true, force: true });
await cp(new URL('public/', root), output, { recursive: true });
await mkdir(new URL('build/bridge/', root), { recursive: true });

await Promise.all([
  build({
    define,
    entryPoints: { app: 'src/index.tsx', background: 'src/chrome/Background.ts', content: 'src/chrome/Content.ts' },
    outdir: 'build/static/js',
    bundle: true,
    minify: true,
    target: 'chrome120',
    format: 'iife',
    legalComments: 'linked',
  }),
  build({
    define,
    entryPoints: { tools: 'src/models/tools.ts', scripts: 'src/services/ScriptService.ts', owners: 'src/services/PlannerAssignee.ts', planner: 'src/services/PlannerTransfer.ts' },
    outdir: 'build/bridge',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  }),
]);

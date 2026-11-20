import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('build/', root);
await rm(output, { recursive: true, force: true });
await cp(new URL('public/', root), output, { recursive: true });
await mkdir(new URL('build/bridge/', root), { recursive: true });

await Promise.all([
  build({
    entryPoints: { app: 'src/index.tsx', background: 'src/chrome/Background.ts', content: 'src/chrome/Content.ts' },
    outdir: 'build/static/js',
    bundle: true,
    minify: true,
    target: 'chrome120',
    format: 'iife',
    legalComments: 'linked',
  }),
  build({
    entryPoints: { tools: 'src/models/tools.ts', scripts: 'src/services/ScriptService.ts' },
    outdir: 'build/bridge',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  }),
]);

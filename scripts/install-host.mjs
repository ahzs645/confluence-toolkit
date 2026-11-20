import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { NATIVE_HOST } from '../build/bridge/tools.mjs';

const browser = process.argv[2] ?? 'chrome';
const mac = process.platform === 'darwin';
if ((!mac && process.platform !== 'linux') || !['chrome', 'chrome-for-testing', 'chromium'].includes(browser)) {
  throw new Error('Use chrome, chrome-for-testing, or chromium on macOS or Linux.');
}
const macPaths = { chrome: 'Google/Chrome', 'chrome-for-testing': 'Google/ChromeForTesting', chromium: 'Chromium' };
const linuxPaths = { chrome: 'google-chrome', 'chrome-for-testing': 'google-chrome-for-testing', chromium: 'chromium' };
const target = process.env.CONFLUENCE_TOOLKIT_NATIVE_DIR || (mac
  ? join(homedir(), 'Library/Application Support', macPaths[browser], 'NativeMessagingHosts')
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), linuxPaths[browser], 'NativeMessagingHosts'));
const launchDir = process.env.CONFLUENCE_TOOLKIT_LAUNCH_DIR || join(homedir(), '.confluence-toolkit');
const launcher = join(launchDir, 'native-host');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const manifest = JSON.parse(await readFile(new URL('../build/manifest.json', import.meta.url), 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));

await mkdir(target, { recursive: true });
await mkdir(launchDir, { recursive: true, mode: 0o700 });

async function atomicWrite(path, data, mode) {
  const staging = path + '-' + randomUUID();
  await writeFile(staging, data, { mode, flag: 'wx' });
  await rename(staging, path);
}

const host = fileURLToPath(new URL('../bridge/host.mjs', import.meta.url));
const socketDir = process.env.CONFLUENCE_TOOLKIT_SOCKET_DIR;
const env = socketDir ? `export CONFLUENCE_TOOLKIT_SOCKET_DIR=${shellQuote(socketDir)}\n` : '';
await atomicWrite(launcher, `#!/bin/sh\n${env}exec ${shellQuote(process.execPath)} ${shellQuote(host)} "$@"\n`, 0o700);
await atomicWrite(join(target, NATIVE_HOST + '.json'), JSON.stringify({
  name: NATIVE_HOST,
  description: 'Confluence Toolkit local assistant bridge',
  path: launcher,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2) + '\n', 0o600);
console.log(`Registered ${NATIVE_HOST} for ${browser} and extension ${extensionId}.`);
console.log(JSON.stringify({
  mcpServers: {
    confluence: { command: process.execPath, args: [fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))] },
  },
}, null, 2));

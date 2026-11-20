import { homedir } from 'node:os';
import { join } from 'node:path';
import { endianness } from 'node:os';
import { lstat, mkdir } from 'node:fs/promises';
import { MAX_NATIVE_PAYLOAD } from '../build/bridge/tools.mjs';

const bigEndian = endianness() === 'BE';
const limit = MAX_NATIVE_PAYLOAD + 4096;

export async function socketPath() {
  const directory = process.env.CONFLUENCE_TOOLKIT_SOCKET_DIR || join(homedir(), '.confluence-toolkit');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error('The Confluence Toolkit socket directory must be private and owned by your account.');
  }
  const path = join(directory, 'bridge.sock');
  if (Buffer.byteLength(path) > 103) throw new Error('The Confluence Toolkit socket path is too long.');
  return path;
}

export function frame(value) {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length > limit) throw new Error('The bridge message exceeds the size limit.');
  const header = Buffer.alloc(4);
  if (bigEndian) header.writeUInt32BE(json.length);
  else header.writeUInt32LE(json.length);
  return Buffer.concat([header, json]);
}

export function receiveFrames(stream, onMessage, onError) {
  let remaining = Buffer.alloc(0);
  let failed = false;
  stream.on('data', chunk => {
    if (failed) return;
    remaining = Buffer.concat([remaining, chunk]);
    try {
      while (remaining.length >= 4) {
        const size = bigEndian ? remaining.readUInt32BE() : remaining.readUInt32LE();
        if (!size || size > limit) throw new Error('Invalid bridge message size.');
        if (remaining.length < 4 + size) break;
        const message = JSON.parse(remaining.subarray(4, 4 + size).toString('utf8'));
        remaining = remaining.subarray(4 + size);
        onMessage(message);
      }
    } catch (error) {
      failed = true;
      onError(error);
    }
  });
}

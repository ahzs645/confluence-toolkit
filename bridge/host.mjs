import { createConnection, createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { frame, receiveFrames, socketPath } from './protocol.mjs';
import { parseTool } from '../build/bridge/tools.mjs';

const pending = new Map();
const clients = new Set();
let server;
let closing = false;

function drop(client) {
  clients.delete(client);
  for (const [id, request] of pending) {
    if (request.client === client) {
      clearTimeout(request.timer);
      pending.delete(id);
    }
  }
}

function respond(client, result) {
  try { client.end(frame(result)); } catch { client.destroy(); }
}

function stop() {
  if (closing) return;
  closing = true;
  for (const client of clients) client.destroy();
  server?.close();
  process.stdin.destroy();
}

function onClient(client) {
  clients.add(client);
  let dispatched = false;
  client.setTimeout(35_000, () => client.destroy());
  client.on('error', () => client.destroy());
  client.on('close', () => drop(client));
  receiveFrames(client, message => {
    if (dispatched || closing) return;
    dispatched = true;
    try {
      if (pending.size >= 16) throw new Error('The Confluence bridge is busy. Try again shortly.');
      const call = parseTool(message?.tool, message?.input);
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        respond(client, { ok: false, error: 'The browser did not answer. Check the outcome before repeating a write.' });
      }, 32_000);
      pending.set(id, { client, timer });
      process.stdout.write(frame({ type: 'call', id, tool: call.name, input: call.input }));
    } catch (error) {
      respond(client, { ok: false, error: error.message });
    }
  }, () => client.destroy());
}

async function removeStaleSocket(path) {
  const old = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!old) return;
  if (!old.isSocket() || old.uid !== process.getuid()) throw new Error('The bridge socket path is unavailable.');
  await new Promise((resolve, reject) => {
    const probe = createConnection(path);
    probe.once('error', error => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve();
      else reject(error);
    });
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error('A Confluence bridge is already running. Stop it in the other Chrome profile first.'));
    });
  });
  const current = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (current?.ino === old.ino) await unlink(path);
}

try {
  const path = await socketPath();
  await removeStaleSocket(path);
  server = createServer(onClient);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdout.on('error', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  receiveFrames(process.stdin, message => {
    if (message?.type !== 'result') return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    respond(request.client, message.result);
  }, stop);
  process.stdout.write(frame({ type: 'ready' }));
} catch (error) {
  process.stdout.write(frame({ type: 'error', error: error.message }));
  stop();
  process.exitCode = 1;
}

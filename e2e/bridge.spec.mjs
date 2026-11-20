import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { frame, receiveFrames } from '../bridge/protocol.mjs';

test('MCP validates tools and passes native messaging in both directions', async () => {
  const directory = await mkdtemp('/tmp/confluence-toolkit-');
  const env = { ...process.env, CONFLUENCE_TOOLKIT_SOCKET_DIR: directory };
  const host = spawn(process.execPath, ['bridge/host.mjs'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(host, 'close');
  const calls = [];
  const client = new Client({ name: 'toolkit-fixture', version: '1' });
  try {
    await new Promise((resolve, reject) => {
      host.once('error', reject);
      host.once('exit', code => reject(new Error('Host exited with status ' + code)));
      receiveFrames(host.stdout, message => {
        if (message.type === 'ready') return resolve();
        if (message.type === 'error') return reject(new Error(message.error));
        calls.push(message);
        const result = message.tool === 'whoami'
          ? { ok: true, data: { name: 'Fixture user' } }
          : { ok: false, status: 409, error: 'version conflict' };
        host.stdin.write(frame({ type: 'result', id: message.id, result }));
      }, reject);
    });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('bridge/server.mjs')], env }));
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['whoami', 'upload_attachment', 'find_page_by_title', 'jira_search', 'jira_transition_issue', 'jira_list_boards', 'jira_get_request']));
    expect(listed.tools.find(tool => tool.name === 'whoami').annotations.readOnlyHint).toBe(true);
    const user = await client.callTool({ name: 'whoami', arguments: {} });
    expect(user.structuredContent).toEqual({ name: 'Fixture user' });
    const update = { pageId: '42', expectedVersion: 3, title: 'New title', storage: 'updated' };
    const conflict = await client.callTool({ name: 'update_page', arguments: update });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0].text).toContain('HTTP 409');
    const missing = await client.callTool({ name: 'update_page', arguments: { ...update, expectedVersion: undefined } });
    expect(missing.isError).toBe(true);
    expect(calls.map(call => [call.tool, call.input])).toEqual([['whoami', {}], ['update_page', update]]);
    await client.close();
    host.stdin.end();
    await closed;
  } finally {
    await client.close();
    if (host.exitCode === null) { host.kill(); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI query, select and replace preview preserve the expected version across a later apply', async () => {
  const directory = await mkdtemp('/tmp/confluence-cli-');
  const env = { ...process.env, CONFLUENCE_TOOLKIT_SOCKET_DIR: directory };
  const host = spawn(process.execPath, ['bridge/host.mjs'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(host, 'close');
  const site = { origin: 'https://fixture.atlassian.net', context: '/wiki', deployment: 'cloud' };
  let page = { id: '42', title: 'Fixture title', version: { number: 3 }, body: { storage: { value: '<p>old old</p>' } } };
  let updates = 0;

  const cli = async (...args) => {
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/confluence.mjs', ...args], { env });
    return JSON.parse(stdout);
  };
  try {
    await new Promise((resolve, reject) => {
      host.once('error', reject);
      host.once('exit', code => reject(new Error('Host exited with status ' + code)));
      receiveFrames(host.stdout, message => {
        if (message.type === 'ready') return resolve();
        if (message.type === 'error') return reject(new Error(message.error));
        let data;
        switch (message.tool) {
          case 'whoami': data = { name: 'Fixture user', id: 'fixture-user', site }; break;
          case 'search': data = { results: [{ content: { id: '42', type: 'page' } }] }; break;
          case 'get_page': data = page; break;
          case 'update_page': {
            const { expectedVersion, title, storage } = message.input;
            if (expectedVersion !== page.version.number) {
              host.stdin.write(frame({ type: 'result', id: message.id, result: { ok: false, status: 409, error: 'conflict' } }));
              return;
            }
            updates++;
            page = { ...page, title, version: { number: expectedVersion + 1 }, body: { storage: { value: storage } } };
            data = page;
            break;
          }
          default: throw new Error('Unexpected CLI tool: ' + message.tool);
        }
        host.stdin.write(frame({ type: 'result', id: message.id, result: { ok: true, data } }));
      }, reject);
    });

    expect((await cli('query', '--cql', 'type = page')).results).toHaveLength(1);
    expect((await cli('select', '--page', '42')).version.number).toBe(3);
    const plan = await cli('replace', '--cql', 'type = page', '--find', 'old', '--with', '$& literal');
    expect(plan.pages).toEqual([{ pageId: '42', expectedVersion: 3, matches: 2 }]);
    expect(updates).toBe(0);
    const file = join(directory, 'plan.json');
    await writeFile(file, JSON.stringify(plan));
    const applied = await cli('apply', '--plan', file);
    expect(applied.results).toEqual([{ pageId: '42', version: 4, matches: 2, updated: true }]);
    expect(page.body.storage.value).toBe('<p>$& literal $& literal</p>');
    await expect(cli('apply', '--plan', file)).rejects.toMatchObject({ code: 1 });
    expect(updates).toBe(1);
    await cli('change', '--page', '42', '--version', '4', '--title', 'Selected fixture');
    expect(page.title).toBe('Selected fixture');
    expect(page.body.storage.value).toBe('<p>$& literal $& literal</p>');
    host.stdin.end();
    await closed;
  } finally {
    if (host.exitCode === null) { host.kill(); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});

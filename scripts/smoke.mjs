import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const client = new Client({ name: 'confluence-toolkit-smoke', version: '0.1.0' });
const server = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url));
const space = process.argv[2];
if (process.argv.length > 3) throw new Error('Pass one optional disposable test space ID or key.');

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(name + ': ' + result.content[0]?.text);
  return result.structuredContent;
}

const cliPath = fileURLToPath(new URL('./confluence.mjs', import.meta.url));
async function cli(...args) {
  const { stdout } = await promisify(execFile)(process.execPath, [cliPath, ...args]);
  return JSON.parse(stdout);
}

async function testCli(pageId) {
  const directory = await mkdtemp(join(tmpdir(), 'confluence-smoke-'));
  try {
    await cli('query', '--cql', 'type = page', '--limit', '2');
    const page = await cli('select', '--page', pageId);
    const updated = await cli('change', '--page', pageId, '--version', String(page.version.number),
      '--title', page.title + ' (CLI)');
    if (updated.version.number !== page.version.number + 1) throw new Error('CLI change did not advance the page version.');
    const plan = await cli('replace', '--page', pageId, '--find', 'Updated toolkit', '--with', 'Verified CLI');
    if (plan.pages.length !== 1 || plan.pages[0].matches !== 1) throw new Error('Unexpected replacement preview.');
    const filename = join(directory, 'plan.json');
    await writeFile(filename, JSON.stringify(plan), { mode: 0o600 });
    const applied = await cli('apply', '--plan', filename);
    if (!applied.results[0]?.updated) throw new Error('CLI replacement did not update the page.');
    const verified = await cli('select', '--page', pageId);
    if (!verified.body?.storage?.value?.includes('Verified CLI')) throw new Error('Replacement was not saved.');
    console.log('CLI query, select, versioned change, preview and apply all passed.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: process.env }));
  const available = await client.listTools();
  console.log(`Discovered ${available.tools.length} MCP tools.`);
  await call('whoami');
  console.log('Signed-in Confluence identity verified.');
  const spaces = await call('list_spaces', { limit: 10 });
  console.log(`Read ${spaces.results.length} spaces.`);
  const search = await call('search', { cql: 'type = page', limit: 5 });
  console.log(`CQL search returned ${search.results.length} pages.`);
  const pageId = search.results.find(result => result.content?.id)?.content.id;
  if (pageId) {
    const page = await call('get_page', { pageId: String(pageId) });
    if (!page.version?.number) throw new Error('Read page returned no version.');
    console.log('Read one page and verified its version.');
    for (const name of ['list_children', 'list_comments', 'list_attachments', 'list_labels']) {
      const result = await call(name, { pageId: String(pageId), limit: 5 });
      console.log(`${name} returned ${result.results.length} results.`);
    }
  }
  if (!space) {
    const blocked = await client.callTool({
      name: 'create_page', arguments: { space: '0', title: 'Read-only gate probe', storage: '' },
    });
    if (!blocked.isError || !blocked.content[0]?.text?.includes('read-only')) {
      throw new Error('Run the read-only smoke test with assistant writes disabled.');
    }
    console.log('Read-only bridge rejected a write.');
  } else {
    const title = 'Confluence Toolkit smoke test ' + new Date().toISOString();
    const created = await call('create_page', { space, title, storage: '<p>Temporary toolkit smoke test.</p>' });
    try {
      const page = await call('get_page', { pageId: created.id });
      const updated = await call('update_page', {
        pageId: page.id, title, expectedVersion: page.version.number, storage: '<p>Updated toolkit smoke test.</p>',
      });
      if (updated.version?.number !== page.version.number + 1) throw new Error('Page version did not increase.');
      console.log('Created and updated one test page and verified its version.');
      await testCli(page.id);
      await call('add_comment', { pageId: page.id, storage: '<p>Test comment</p>' });
      const comments = await call('list_comments', { pageId: page.id });
      if (!comments.results.length) throw new Error('The comment was not listed.');
      console.log('Added and listed a comment.');
      await call('add_label', { pageId: page.id, name: 'toolkit-smoke' });
      const labels = await call('list_labels', { pageId: page.id });
      if (!labels.results.some(label => label.name === 'toolkit-smoke')) throw new Error('The label was not listed.');
      await call('remove_label', { pageId: page.id, name: 'toolkit-smoke' });
      console.log('Added, listed and removed a label.');
      try {
        await call('upload_attachment', {
          pageId: page.id, filename: 'toolkit-smoke.txt', contentType: 'text/plain', dataBase64: Buffer.from('Temporary toolkit smoke test.').toString('base64'),
        });
        const attachments = await call('list_attachments', { pageId: page.id });
        if (!attachments.results.some(attachment => attachment.title === 'toolkit-smoke.txt')) {
          throw new Error('The attachment was not listed.');
        }
        console.log('Uploaded and listed an attachment.');
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    } finally {
      await call('trash_page', { pageId: created.id, confirm: true });
      console.log('Moved the generated test page to the Confluence trash.');
    }
  }
} finally {
  await client.close();
}

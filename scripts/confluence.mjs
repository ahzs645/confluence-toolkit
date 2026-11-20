import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { executeScriptCommand } from '../build/bridge/scripts.mjs';

const help = `confluence query (--text TEXT | --cql CQL) [--limit N] [--cursor TOKEN | --start N]
confluence select --page ID
confluence change --page ID --version N [--title TITLE] [--storage-file FILE]
confluence replace (--page ID | --cql CQL) --find TEXT --with TEXT [--field storage|title] [--limit N]
confluence apply --plan FILE

Use "replace" to preview literal replacements. Redirect its JSON to a file and
pass that file to "apply". Start the Chrome bridge with writes for change/apply.`;

const option = { type: 'string' };
const definitions = {
  query: { cql: option, text: option, limit: option, cursor: option, start: option },
  select: { page: option },
  change: { page: option, version: option, title: option, 'storage-file': option },
  replace: { page: option, cql: option, find: option, with: option, field: option, limit: option },
  apply: { plan: option },
};

const client = new Client({ name: 'confluence-toolkit-cli', version: '0.1.0' });

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content[0]?.text ?? 'Confluence returned an error.');
  return response.structuredContent;
}

async function scriptInput(command, values) {
  const { page: pageId, version, limit, start, 'storage-file': storageFile, plan, ...options } = values;
  return {
    command, ...options,
    ...(pageId === undefined ? {} : { pageId }),
    ...(version === undefined ? {} : { expectedVersion: Number(version) }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(start === undefined ? {} : { start: Number(start) }),
    ...(storageFile === undefined ? {} : { storage: await readFile(storageFile, 'utf8') }),
    ...(plan === undefined ? {} : { plan: JSON.parse(await readFile(plan, 'utf8')) }),
  };
}

const [, , command, ...args] = process.argv;
if (!command || command === '--help' || command === 'help') {
  console.log(help);
} else {
  try {
    if (!Object.hasOwn(definitions, command)) throw new Error('Unknown command: ' + command);
    const { values } = parseArgs({ args, options: definitions[command] });
    const server = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: process.env }));
    const output = await executeScriptCommand(call, await scriptInput(command, values));
    if (command === 'apply' && output.results.some(result => !result.updated)) process.exitCode = 1;
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

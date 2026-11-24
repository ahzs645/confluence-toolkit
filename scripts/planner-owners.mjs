import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assignmentEmails, importPlannerOwners, ownersField, plannerOwners } from '../build/bridge/owners.mjs';
import { plannerFile } from '../build/bridge/planner.mjs';

const {values:{project,file}} = parseArgs({options:{project:{type:'string'},file:{type:'string'}}});
if (!/^[A-Z][A-Z0-9_]*$/.test(project ?? '') || !file) {
  throw new Error('Usage: npm run planner:owners -- --project CPCT --file /path/to/planner-export.json');
}
const plan = plannerFile.parse(JSON.parse(await readFile(file,'utf8')));
if (!plan.plan.id) throw new Error('The export needs a plan ID.');
const cards = new Map();
for (const card of plan.tasks) {
  if (!card.id) throw new Error('Every card needs a source ID.');
  const marker='planner-src-'+createHash('sha256').update(JSON.stringify([plan.plan.id,card.id,'card',''])).digest('hex');
  if (cards.has(marker)) throw new Error('Duplicate card ID in export: '+card.id);
  cards.set(marker,card);
}
const client = new Client({name:'planner-owner-import',version:'1.0.0'});
async function run(name,args) {
  const readOnly = ['jira_search','jira_get_issue','jira_get_issue_fields','jira_search_users','jira_get_project','jira_whoami'].includes(name);
  for (let attempt = 0; ; attempt++) {
    const response = await client.callTool({name,arguments:args});
    if (!response.isError) return response.structuredContent;
    const message = response.content[0]?.text || name+' failed.';
    const status = Number(message.match(/^HTTP (\d+):/)?.[1]);
    const retryable = [429,502,503,504].includes(status) || /did not complete the request|timed out/i.test(message);
    if (!readOnly || !retryable || attempt >= 3) throw Object.assign(new Error(message),{status});
    await delay(1500 * 2 ** attempt);
  }
}
try {
  const server = fileURLToPath(new URL('../bridge/server.mjs',import.meta.url));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[server],env:process.env}));
  const target = await run('jira_get_project',{projectKey:project});
  if (target.key !== project || (await run('jira_whoami',{})).site?.deployment !== 'cloud') throw new Error('Expected a Jira Cloud project matching '+project);
  const bySource = new Map(), seenTokens = new Set();
  let token;
  do {
    const page = await run('jira_search',{jql:'project = "'+project+'" ORDER BY key',fields:['project','issuetype'],
      plannerProperties:true,limit:100,nextPageToken:token});
    for (const issue of page.issues) {
      const marker = issue.properties?.plannerSource;
      if (!cards.has(marker) || issue.fields.issuetype.subtask) continue;
      if (bySource.has(marker)) throw new Error('Duplicate Jira matches for '+cards.get(marker).title);
      bySource.set(marker,issue.key);
    }
    token=page.nextPageToken;
    if (token && seenTokens.has(token)) throw new Error('Jira repeated a search page.');
    seenTokens.add(token);
  } while(token);
  const emailDirectory=assignmentEmails(plan),cache=new Map();
  async function transfer([marker,card]) {
    const key=bySource.get(marker), owners=plannerOwners(card);
    if (!key) return {card:card.title,owners,warnings:['No imported issue with this Planner source ID']};
    const issue=await run('jira_get_issue',{issue:key,plannerProperties:true});
    if (issue.fields.project.key!==project || issue.properties?.plannerSource!==marker || issue.fields.issuetype.subtask)
      throw new Error('Source identity changed for '+key);
    const field=owners.length ? ownersField((await run('jira_get_issue_fields',{issue:key})).fields) : undefined;
    if (owners.length && !field) throw new Error('Add an editable multi-person field named Planner owners to '+key+' and rerun.');
    const warnings=new Set();
    const result=await importPlannerOwners(run,project,key,card,issue.fields,true,field,emailDirectory.get(card.id),cache,warnings);
    return {key,card:card.title,owners:result.owners,unmatched:result.unmatched,assignee:result.assignee,
      jiraOwners:result.stored.map(u=>u.displayName),warnings:[...warnings]};
  }
  const entries = [...cards];
  const results = [];
  for (let i = 0; i < entries.length; i += 3) {
    if (i % 30 === 0) console.error('Processing card',i+1,'of',cards.size);
    const batch = await Promise.allSettled(entries.slice(i,i+3).map(transfer));
    for (const row of batch) {
      if (row.status === 'rejected') throw row.reason;
      results.push(row.value);
    }
  }
  console.log(JSON.stringify({project,plan:plan.plan.title,results},null,2));
} finally {
  await client.close();
}

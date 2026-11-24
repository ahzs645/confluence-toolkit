import type { Binding } from '../models/messages';
import { request } from './ExtensionCommunicationService';
import { plannerSections, sectionsText, sectionsDocument, type PlannerImportOptions } from './PlannerDescription';
import { jiraRows, labelText, legacyPlannerDescription, type PlannerFile, type Row } from './PlannerTransfer';

import { assignmentEmails, importPlannerOwners, ownersField, plannerOwners } from './PlannerAssignee';
import { nativePlannerFields, type EditFields } from './PlannerTaskFields';

type Issue = { key: string; properties?: {plannerSource?:string}; fields: { project: { key: string }; summary: string; labels: string[];
  assignee?: { accountId?:string; name?:string; displayName?:string }; parent?: { key: string }; status: { name: string }; description?: unknown; duedate?: string;
  issuetype: { id: string; subtask: boolean }; [field: string]: unknown } };
type Checkpoint = { key?: string; pending?: boolean; complete?: boolean };
type Tool = <T>(name: string, input: Record<string, unknown>) => Promise<T>;

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as { text?: string; content?: unknown[] };
  return node.text ?? node.content?.map(textOf).join('\n') ?? '';
}

function plainDescription(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  type Node = {type?: string; attrs?: {url?:string}; text?: string; marks?: {type:string;attrs?:{href?:string}}[]; content?: Node[]};
  const doc = value as Node | null;
  if (doc?.type !== 'doc' || !doc.content) return undefined;
  const lines: string[] = [];
  for (const block of doc.content) {
    if (block.type !== 'paragraph') return undefined;
    let line = '';
    for (const part of block.content || []) {
      if (part.type === 'hardBreak') line += '\n';
      else if (part.type === 'inlineCard' && typeof part.attrs?.url === 'string') line += part.attrs.url;
      else if (part.type === 'text' && !part.marks?.some(m => m.type !== 'link' || m.attrs?.href !== part.text)) line += part.text;
      else return undefined;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function sameLayout(a: unknown, b: unknown) {
  // Jira can add local IDs and reorder object keys without changing content or marks.
  const canonical = (_key: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key,item]) => key !== 'localId' && !(key === 'content' && Array.isArray(item) && !item.length))
      .sort(([left],[right]) => left.localeCompare(right))) : value;
  // Jira Cloud can return an empty ADF document after clearing a description with null.
  function serialize(value: unknown) {
    const doc = value as {type?:string;content?:unknown[]} | null;
    if (doc?.type === 'doc' && Array.isArray(doc.content) && !doc.content.length) return 'null';
    return JSON.stringify(value,canonical);
  }
  return serialize(a) === serialize(b);
}

function generatedLayout(saved: unknown, file: PlannerFile, card: PlannerFile['tasks'][number], cloud: boolean) {
  // Jira CSV imports can represent the same text as paragraphs or hard breaks.
  if (saved == null) return plannerSections(file,card).length === 0;
  const normalize = (s:string) => s.split(/\r?\n/).map(line => line.trimEnd()).join('\n');
  const plain = plainDescription(saved);
  const savedText = plain === undefined ? undefined : normalize(plain);
  if (savedText === normalize(legacyPlannerDescription(file,card))) return true;
  const matches = (options:PlannerImportOptions, layout: 'current'|'previous'|'original' = 'current') => {
    const sections = plannerSections(file,card,options,layout);
    return savedText === normalize(sectionsText(sections)) || (cloud && sameLayout(saved,sectionsDocument(sections)));
  };
  // Infer the optional lines, then compare the entire document before replacing it.
  const sections = new Map<string,string[]>();
  if (savedText !== undefined) {
    for (const block of savedText.split('\n\n')) {
      const [heading,...lines] = block.split('\n');
      sections.set(heading,lines);
    }
  } else {
    const content = (saved as {content?:unknown[]} | null)?.content;
    if (!Array.isArray(content)) return false;
    let lines: string[] = [];
    for (const block of content) {
      if ((block as {type?:string} | null)?.type === 'heading') {
        lines = [];
        sections.set(textOf(block),lines);
      } else lines.push(textOf(block));
    }
  }
  const progress = sections.get('Progress') || [];
  const source = sections.get('Planner source') || [];
  const options = {
    history: sections.has('Change history (UTC)'),
    effortText: sections.has('Effort') || sections.has('Schedule and effort'),
    priorityText: progress.some(line => line.startsWith('Priority: ')),
    progressText: progress.some(line => /^(Progress|Status): /.test(line)),
    scheduleText: sections.has('Schedule'),
    conversationText: sections.get('Related work')?.some(line => line.startsWith('Conversations: ')),
    sourceText: sections.has('Planner source'),
    planText: source.some(line => line.startsWith('Plan: ') || line === file.plan.url),
  };
  return matches(options) || matches(options,'previous') || matches({history:true,effortText:true},'original');
}

async function fingerprint(parts: string[]) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function existingIssues(run: Tool, project: string, cloud: boolean) {
  const issues: Issue[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const result: { issues: Issue[]; nextPageToken?: string; total?: number } = await run('jira_search', {
      jql: `project = "${project}" ORDER BY key`,
      fields: ['summary','status','issuetype','parent','project','labels','description'],
      plannerProperties:cloud, limit: 25, start: issues.length, nextPageToken: token,
    });
    if (!cloud) {
      // Data Center exposes entity properties on the individual issue read.
      for (const issue of result.issues) {
        if (!issue.properties?.plannerSource) {
          const details = await run<Issue>('jira_get_issue',{issue:issue.key,plannerProperties:true,identityOnly:true});
          issue.properties = details.properties;
        }
      }
    }
    issues.push(...result.issues);
    if (!cloud) {
      if (!result.issues.length || issues.length >= (result.total ?? issues.length)) return issues;
      continue;
    }
    token = result.nextPageToken;
    if (!token) return issues;
    if (seen.has(token)) throw new Error('Jira repeated a search page.');
    seen.add(token);
  }
}

function sameSource(issue: Issue, row: Row, marker: string, parent?: string) {
  if ((issue.fields.parent?.key ?? undefined) !== parent) return false;
  if (issue.properties?.plannerSource) return issue.properties.plannerSource === marker;
  if (issue.fields.labels.includes(marker)) return true;
  const lines = textOf(issue.fields.description).split(/\r?\n/).map(t => t.trim());
  if (!parent) return lines.includes('id: ' + row.cardId) || lines.includes('Planner card ID: ' + row.cardId);
  if (!row.cardId || !lines.includes(row.cardId)) return false;
  if (row.itemId && (lines.includes(row.itemId) || lines.includes('Original template checklist ID: ' + row.itemId))) return true;
  return Boolean((row.templateItem || !row.itemId) && issue.fields.summary === row.title.trim().slice(0,255));
}

export function isPlannerHeading(issue: Issue) {
  if (issue.fields.issuetype.subtask) return false;
  return Boolean(issue.properties?.plannerSource || issue.fields.labels.includes('planner-card') ||
    /^Planner card ID: .+$/m.test(textOf(issue.fields.description)));
}

type SourceLink = { id: string; title: string; url: string };
function sourceLinks(file: PlannerFile, card: PlannerFile['tasks'][number]) {
  const links: SourceLink[] = [];
  if (file.plan.url) links.push({id: 'plan', title: file.plan.title || 'Planner plan', url: file.plan.url});
  for (const a of Array.isArray(card.attachments) ? card.attachments : []) {
    if (typeof a?.uri === 'string') links.push({id: String(a.id || a.uri), title: String(a.name || 'Planner attachment'), url:a.uri});
  }
  return links.filter(link => {
    try { const u = new URL(link.url); return /^https?:$/.test(u.protocol) && !u.username && !u.password; }
    catch { return false; }
  });
}

export function plannerBuckets(file: PlannerFile) {
  return [...new Set([...(file.plannerRecords?.buckets || []).map(b => b.name),
    ...file.tasks.map(t => t.bucket)].filter((label): label is string => typeof label === 'string' && Boolean(label.trim())))];
}

type CategoryOption = {id: string; value: string; disabled?: boolean};
type CategoryField = {fieldId: string; schema?: {custom?: string}; allowedValues?: CategoryOption[]};

async function projectCategoryField(run: Tool, projectKey: string, issueTypeId: string) {
  let start = 0;
  while (true) {
    const page = await run<{fields: CategoryField[]; total: number}>('jira_get_create_fields', {projectKey, issueTypeId, start, limit:50});
    const field = page.fields.find(f => f.schema?.custom === 'com.atlassian.jira.plugin.system.customfieldtypes:jwm-category');
    if (field) return field;
    start += page.fields.length;
    if (!page.fields.length || start >= page.total) throw new Error('This work type has no Jira business-space Category field. Disable bucket import or choose another destination.');
  }
}

async function projectPriorities(run: Tool, projectKey: string, issueTypeId: string) {
  let start = 0;
  for (;;) {
    const page = await run<{fields:{fieldId:string;allowedValues?:{name:string}[]}[];total:number}>(
      'jira_get_create_fields',{projectKey,issueTypeId,start,limit:50});
    const field = page.fields.find(f=>f.fieldId === 'priority');
    if (field) return field.allowedValues?.map(v=>v.name) || [];
    start += page.fields.length;
    if (!page.fields.length || start >= page.total) return [];
  }
}

async function prepareBuckets(run: Tool, projectKey: string, projectId: string, issueTypeId: string, file: PlannerFile) {
  const field = await projectCategoryField(run, projectKey, issueTypeId);
  const options = new Map((field.allowedValues || []).filter(o => !o.disabled).map(o => [o.value, o.id]));
  for (const name of plannerBuckets(file)) {
    if (options.has(name)) continue;
    const response = await run<{data?: {createJwmCategory?: {success:boolean; errors?:{message:string}[];
      category?: {option: {optionId:string;value:string}}}}; errors?:{message:string}[]}>(
        'jira_create_category', {projectId, issueTypeId, value:name});
    const result = response.data?.createJwmCategory;
    if (!result?.success || !result.category?.option.optionId || result.category.option.value!==name) {
      throw new Error('Jira could not create category "' + name + '". ' +
        (result?.errors?.[0]?.message || response.errors?.[0]?.message || 'Check category permissions.'));
    }
    options.set(name, result.category.option.optionId);
  }
  return {fieldId:field.fieldId, options};
}

export async function importPlanner(binding: Binding, project: string, file: PlannerFile, template: number | undefined,
  progress: (message: string) => void, copyBuckets = false, matchOnly = false, options: PlannerImportOptions = {}) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(project) || !file.plan.id) throw new Error('Select a project and a Planner export with a plan ID.');
  const rows = jiraRows(file, template, options);
  if (!rows.length || rows.some(r => !r.cardId)) throw new Error('Direct import requires stable Planner card IDs. Use the browser export.');
  const run: Tool = (tool, input) => request({type:'tool', tool, input, documentId:binding.documentId});
  const scope = [binding.site.origin + binding.site.context, project, file.plan.id];
  return navigator.locks.request('planner-jira-' + JSON.stringify(scope.slice(0,2)), async () => {
    const target = await run<{id:string;key:string; issueTypes: {id:string;name:string;subtask:boolean}[]}>('jira_get_project',{projectKey:project});
    if (target.key !== project) throw new Error('Jira returned a different project.');
    const taskType = target.issueTypes.find(t=>t.name.toLowerCase()==='task' && !t.subtask);
    const childType = target.issueTypes.find(t=>t.subtask && /^sub[ -]?task$/i.test(t.name));
    if (!taskType || (rows.some(r=>r.parent) && !childType)) throw new Error('The destination needs Task and Sub-task work types.');
    const candidates = await existingIssues(run,project,binding.site.deployment==='cloud');
    const keys = new Map<number,string>();
    const ownerCache = new Map<string,string[]>();
    const emailsByCard = assignmentEmails(file);
    const cards = new Map(file.tasks.map(t=>[t.id,t]));
    const markers = await Promise.all(rows.map(r=>fingerprint([file.plan.id!, r.cardId!, r.parent ? (r.templateItem?'template':'item'):'card',
      r.parent ? r.itemId || r.title.trim() : ''])));
    if (new Set(markers).size!==rows.length) throw new Error('The export contains duplicate source identities. Resolve them before importing.');
    const categories = copyBuckets ? await prepareBuckets(run,project,target.id,taskType.id,file) : undefined;
    if (categories && childType && rows.some(r => r.parent)) {
      const childField = await projectCategoryField(run,project,childType.id);
      if (childField.fieldId !== categories.fieldId) throw new Error('Task and Sub-task use different category fields in this project.');
    }
    let created = 0, reused = 0;
    let priorityNames: string[] | undefined;
    const warnings = new Set<string>();
    for (const [index,row] of rows.entries()) {
      const marker = 'planner-src-' + markers[index];
      const storageKey = JSON.stringify([...scope,marker]);
      const save = (state: Checkpoint) => chrome.storage.local.set({[storageKey]:state});
      const state: Checkpoint = (await chrome.storage.local.get(storageKey))[storageKey] || {};
      const parent = row.parent ? keys.get(row.parent) : undefined;
      const type = row.parent ? childType! : taskType;
      const title = row.title.trim().slice(0,255);
      progress(`Importing ${index+1} of ${rows.length} · ${title}`);
      const matches = candidates.filter(i=>sameSource(i,row,marker,parent));
      if (matches.length>1 || (state.key && matches.some(i=>i.key!==state.key))) throw new Error('Ambiguous Jira matches for '+title+'. Resolve them before retrying.');
      let key = state.key || matches[0]?.key;
      if (!key && matchOnly) throw new Error('No existing Jira match for '+title+'. Match-only mode cannot create work items.');
      if (!key && state.pending) throw new Error('Jira has not confirmed the previous create for '+title+'. Check the project before retrying.');
      const labels = [...row.labels,...(row.templateItem?['implementation-template']:[])];
      const card = cards.get(row.cardId)!;
      const cloud = binding.site.deployment === 'cloud';
      const formatted = !row.description ? null : !parent && cloud
        ? sectionsDocument(plannerSections(file,card,options)) : row.description;
      const creating = !key;
      if (!key) {
        let priority = row.priority;
        if (cloud && priority && card.priority && priority.toLowerCase() !== card.priority.toLowerCase()) {
          priorityNames ??= await projectPriorities(run,project,type.id);
          priority = priorityNames.find(name=>name.toLowerCase()===card.priority!.toLowerCase()) || priority;
        }
        await save({pending:true});
        try {
          const createdIssue=await run<{key:string}>('jira_create_issue',{projectKey:project,issueTypeId:type.id,summary:title,plannerSource:marker,
            ...(typeof formatted === 'string' ? {description:formatted} : {}),
            fields:{...(!parent && plannerOwners(card).length > 1 ? {assignee:null} : {}),...(typeof formatted === 'string' ? {} : {description:formatted}),labels,...(parent?{parent:{key:parent}}:{}),
              ...(row.due?{duedate:row.due}:{}),...(priority?{priority:{name:priority}}:{})}});
          key=createdIssue.key;
          if (!key) throw new Error('Jira returned no issue key.');
        } catch (error) {
          if (error instanceof Error && 'status' in error && [400,401,403,404,422,429].includes(Number(error.status))) await save({});
          throw error;
        }
        await save({key}); created++;
      } else reused++;
      const issue=await run<Issue>('jira_get_issue',{issue:key,plannerProperties:true});
      if(issue.fields.project.key!==project || issue.fields.issuetype.id!==type.id ||
          (parent && issue.fields.parent?.key!==parent) || (!state.complete && !matches.length && issue.fields.summary!==title) ||
          (issue.properties?.plannerSource && issue.properties.plannerSource !== marker))
        throw new Error('Jira work item does not match the source: '+key);
      keys.set(row.id,key);
      const obsolete = new Set([marker, parent ? 'planner-checklist' : 'planner-card']);
      if (!parent && card.bucket) {
        obsolete.add(labelText('bucket-' + card.bucket));
        if (/\bblocked\b/i.test(card.bucket)) obsolete.add('blocked');
      }
      const retained = issue.fields.labels.filter(label => !obsolete.has(label) || labels.includes(label));
      const nextLabels = [...new Set([...retained, ...(state.complete ? [] : labels)])];
      const updateLabels = !sameLayout(nextLabels,issue.fields.labels);
      const storeSource = issue.properties?.plannerSource !== marker;
      if (storeSource || updateLabels) {
        await run('jira_update_issue',{issue:key, fields:updateLabels ? {labels:nextLabels} : {},
          ...(storeSource ? {plannerSource:marker} : {})});
        const saved = await run<Issue>('jira_get_issue',{issue:key,plannerProperties:true});
        if ((storeSource && saved.properties?.plannerSource !== marker) ||
            (updateLabels && (nextLabels.some(l=>!saved.fields.labels.includes(l)) ||
              saved.fields.labels.some(l=>obsolete.has(l) && !labels.includes(l)))))
          throw new Error('Jira did not confirm Planner identity or labels on '+key);
      }
      const bucket = cards.get(row.cardId)?.bucket;
      const categoryId = categories && bucket ? categories.options.get(bucket) : undefined;
      const savedCategory = categories ? issue.fields[categories.fieldId] as {id?:string}|null : null;
      if (categoryId && categories && savedCategory?.id !== categoryId) {
        if (savedCategory?.id) warnings.add(key+' already has a different Jira category');
        else {
          await run('jira_update_issue',{issue:key,fields:{[categories.fieldId]:{id:categoryId}}});
          const saved=await run<Issue>('jira_get_issue',{issue:key});
          if ((saved.fields[categories.fieldId] as {id?:string}|null)?.id !== categoryId)
            throw new Error('Jira did not confirm the bucket on '+key);
        }
      }
      let meta: {fields:EditFields} | undefined;
      if (!parent) {
        const hasOwners = plannerOwners(card).length > 0;
        const useEstimates = options.estimates === true && file.source === 'planner-browser';
        if (hasOwners || useEstimates || Object.keys(row.custom || {}).length)
          meta = await run('jira_get_issue_fields',{issue:key});
        if (hasOwners) {
          // A just-created task may have a project default assignee. A matched sole owner takes precedence.
          const current = creating && plannerOwners(card).length === 1 ? {...issue.fields,assignee:null} : issue.fields;
          await importPlannerOwners(run,project,key,card,current,cloud,ownersField(meta!.fields),
            emailsByCard.get(row.cardId!),ownerCache,warnings);
        }
        const extra = nativePlannerFields(row, card, meta?.fields || {}, issue.fields, useEstimates, key, warnings);
        // Compare the complete generated layout before updating so Jira edits survive a rerun.
        if (matches.length && !sameLayout(issue.fields.description, formatted)) {
          if (generatedLayout(issue.fields.description, file, card, cloud)) extra.fields.description = formatted;
          else warnings.add(key+' kept its existing description because it differs from the Planner export');
        }
        if (Object.keys(extra.fields).length) {
          await run('jira_update_issue',{issue:key,fields:extra.fields});
          const saved = await run<Issue>('jira_get_issue',{issue:key});
          const tracking = (saved.fields.timetracking || {}) as Record<string,unknown>;
          if (('description' in extra.fields && !sameLayout(saved.fields.description, formatted))
            || Object.entries(extra.expected).some(([id,v]) => saved.fields[id] !== v)
            || Object.entries(extra.expectedSeconds).some(([id,v]) => tracking[id] !== v))
            throw new Error('Jira did not confirm the imported fields on '+key+'. Check the issue before resuming.');
        }
      }
      if(state.complete) continue;
      await save({...state,key,pending:false});
      const fields: Record<string,unknown>={};
      if(row.due && !issue.fields.duedate) fields.duedate=row.due;
      else if(row.due && issue.fields.duedate!==row.due) warnings.add(key+' already has a different due date');
      let startId: string | undefined;
      if(row.start) {
        meta ??= await run<{fields:EditFields}>('jira_get_issue_fields',{issue:key});
        const startFields=Object.entries(meta.fields).filter(([,f])=>f.name.toLowerCase()==='start date' && f.schema?.type==='date');
        if(startFields.length===1) {
          startId=startFields[0][0];
          if (!issue.fields[startId]) fields[startId]=row.start;
          else if (issue.fields[startId]!==row.start) warnings.add(key+' already has a different start date');
        } else warnings.add(key+' has no unique editable start-date field');
      }
      if(Object.keys(fields).length) await run('jira_update_issue',{issue:key,fields});
      if(row.status && issue.fields.status.name!==row.status) {
        const transitions=await run<{transitions:{id:string;to:{name:string}}[]}>('jira_list_transitions',{issue:key});
        const t=transitions.transitions.find(t=>t.to.name.toLowerCase()===row.status.toLowerCase());
        if(!t) throw new Error(`${key} has no available transition to ${row.status}. Resume after correcting the workflow.`);
        await run('jira_transition_issue',{issue:key,transitionId:t.id});
      }
      if (!parent) {
        const links = sourceLinks(file,card);
        const existing = links.length && matches.length
          ? (await run<{results:{object?:{url?:string}}[]}>('jira_list_web_links',{issue:key})).results : [];
        for (const link of links) {
          if (existing.some(saved => saved.object?.url === link.url)) continue;
          await run('jira_put_web_link',{issue:key,globalId:'planner:'+await fingerprint([marker,link.id]),title:link.title.slice(0,255),url:link.url});
        }
      }
      const verified=await run<Issue>('jira_get_issue',{issue:key});
      if ((row.status && verified.fields.status.name!==row.status) ||
          (row.due && verified.fields.duedate!==(issue.fields.duedate || row.due)) || (startId && verified.fields[startId] !== (issue.fields[startId] || row.start)))
        throw new Error('Jira readback differed for '+key+'. Check the issue before resuming.');
      await save({key,complete:true});
    }
    return `Verified ${rows.length} work ${rows.length===1 ? 'item' : 'items'} in ${project}. Created ${created}, reused ${reused}.`+
      (rows.length===1 ? ' Jira issue '+keys.get(rows[0].id)+'.' : '') +
      (categories ? ' Matched '+plannerBuckets(file).length+' Planner buckets to Jira categories.' : '') +
      (warnings.size?' Review: '+[...warnings].join('. '):'');
  });
}

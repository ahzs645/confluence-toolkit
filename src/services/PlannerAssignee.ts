import type { PlannerFile } from './PlannerTransfer';
import type { EditFields } from './PlannerTaskFields';

type User = { accountId?:string; name?:string; displayName?:string; emailAddress?:string; active?:boolean; accountType?:string };
type Tool = <T>(name:string,input:Record<string,unknown>)=>Promise<T>;
const normalize = (value?:string) => value?.trim().toLowerCase();

// Older browser exports keep email addresses in the plan resource directory.
export function assignmentEmails(file: PlannerFile) {
  const resources = new Map(file.plannerRecords?.resources?.flatMap(r => r ? [[r.id,r] as const] : []));
  const result = new Map<string, Map<string, Set<string>>>();
  for (const assignment of file.plannerRecords?.assignments || []) {
    if (!assignment) continue;
    const resource = resources.get(assignment.resourceId);
    const name = normalize(resource?.name ?? undefined);
    const email = normalize(resource?.userPrincipalName ?? undefined);
    if (!name || !email) continue;
    const owners = result.get(assignment.taskId) ?? new Map<string, Set<string>>();
    const addresses = owners.get(name) ?? new Set<string>();
    addresses.add(email);
    owners.set(name, addresses);
    result.set(assignment.taskId, owners);
  }
  return result;
}

type Card = PlannerFile['tasks'][number];
type Directory = Map<string,Set<string>>;
type Cache = Map<string,string[]>;
type IssueFields = Record<string,unknown> & {assignee?:User|null};

declare const __PLANNER_OWNER_LAST__: string;
const preferredLast = typeof __PLANNER_OWNER_LAST__ === 'string' ? __PLANNER_OWNER_LAST__ : '';

export function plannerOwners(card:Card, ownerLast = preferredLast):string[] {
  const names = new Map<string,string>();
  for (const raw of Array.isArray(card.assignedTo) ? card.assignedTo : []) {
    if (typeof raw === 'string' && raw.trim()) names.set(normalize(raw)!, raw.trim());
  }
  const lastName = ownerLast.trim().toLowerCase();
  const manager = names.get(lastName);
  names.delete(lastName);
  return [...names.values(), ...(manager ? [manager] : [])];
}

function sourceEmails(card:Card, owner:string, directory:Directory|undefined) {
  const emails = new Set(directory?.get(normalize(owner)!));
  const names = Array.isArray(card.assignedTo) ? card.assignedTo : [];
  // Some exports omit empty email slots. Only zip complete, aligned arrays.
  if (Array.isArray(card.assignedToEmails) && names.length === card.assignedToEmails.length) {
    for (const [i,name] of names.entries()) {
      const email = card.assignedToEmails[i];
      if (typeof name === 'string' && normalize(name) === normalize(owner) && typeof email === 'string' && email.trim())
        emails.add(normalize(email)!);
    }
  }
  return emails;
}

async function findAccounts(run:Tool,project:string,owner:string,email:string|undefined,cloud:boolean,cache:Cache) {
  const key = JSON.stringify([project,cloud,normalize(owner),email]);
  const cached = cache.get(key);
  if (cached) return cached;
  const ids = new Set<string>();
  for (const query of new Set([email,owner].filter((q):q is string=>Boolean(q)))) {
    for (let start=0;;start+=100) {
      const page = await run<{results:User[]}>('jira_search_users',{projectKey:project,query,limit:100,start});
      for (const u of page.results) {
        const id = cloud ? u.accountId : u.name;
        if (!id || u.active === false || (u.accountType && u.accountType !== 'atlassian')) continue;
        const exact = email ? normalize(u.emailAddress) === email :
          [u.displayName,u.emailAddress,u.name].some(v=>normalize(v) === normalize(owner));
        if (exact) ids.add(id);
      }
      if (page.results.length < 100 || ids.size > 1) break;
    }
    if (ids.size) break;
  }
  const result = [...ids];
  cache.set(key,result);
  return result;
}

export function ownersField(edit:EditFields) {
  const fields = Object.entries(edit).filter(([,f])=>f.name === 'Planner owners');
  if (fields.length !== 1) return undefined;
  const [id,f] = fields[0];
  if (/^customfield_\d+$/.test(id) && f.schema?.type === 'array' && f.schema.items === 'user' &&
    f.schema.configuration?.isMulti !== false && (!f.operations || f.operations.includes('set'))) return id;
}

export async function importPlannerOwners(run:Tool, project:string, key:string, card:Card,
  current:IssueFields, cloud:boolean, field:string|undefined, directory:Directory|undefined, cache:Cache, warnings:Set<string>, ownerLast = preferredLast) {
  const owners = plannerOwners(card,ownerLast);
  const matched = new Map<string,string>();
  for (const owner of owners) {
    const emails = sourceEmails(card,owner,directory);
    if (emails.size > 1) {
      warnings.add(key+' needs an owner review. '+owner+' has conflicting Planner email addresses');
      continue;
    }
    const ids = await findAccounts(run,project,owner,[...emails][0],cloud,cache);
    if (ids.length === 1) matched.set(owner,ids[0]);
    else warnings.add(key+' needs an owner review. '+owner+' has '+ids.length+' exact matches among assignable Jira users');
  }
  const idOf = (u:User)=>cloud ? u.accountId : u.name;
  const primary = owners.length === 1 ? matched.get(owners[0]) : undefined;
  if (primary && current.assignee && idOf(current.assignee) !== primary)
    warnings.add(key+' kept its existing Jira assignee. Planner owner is '+owners[0]);
  const previous = field ? (current[field] ?? []) as User[] : [];
  if (!Array.isArray(previous) || previous.some(u=>!u || !idOf(u))) throw new Error('Unexpected Planner owners value on '+key);
  const existing = previous.map(u=>idOf(u)!);
  const expected = [...new Set([...matched.values(),...existing])];
  const manager = owners.find(o=>normalize(o)===normalize(ownerLast));
  const managerId = manager && matched.get(manager);
  if (managerId) {
    expected.splice(expected.indexOf(managerId),1);
    expected.push(managerId);
  }
  const missing = expected.some(id=>!existing.includes(id));
  if (owners.length && !field) warnings.add('Add an editable multi-person field named Planner owners to the Task layout to import all owners.');
  if (field && missing) {
    await run('jira_update_issue',{issue:key,fields:{[field]:expected.map(id=>cloud ? {accountId:id} : {name:id})}});
  }
  if (primary && !current.assignee) {
    try { await run('jira_assign_issue',{issue:key,assignee:primary}); }
    catch(error) {
      if (!(error instanceof Error && 'status' in error && [400,403].includes(Number(error.status)))) throw error;
      warnings.add(key+' could not assign '+owners[0]+'. '+error.message);
    }
  }
  const changed = (field && missing) || (primary && !current.assignee);
  const saved = changed ? (await run<{fields:IssueFields}>('jira_get_issue',{issue:key})).fields : current;
  const stored = field ? ((saved[field] ?? []) as User[]).map(idOf) : [];
  if (field && expected.some(id=>!stored.includes(id))) throw new Error('Jira did not confirm the Planner owners on '+key);
  if (primary && !current.assignee && idOf(saved.assignee || {}) !== primary)
    warnings.add(key+' has no verified assignment to '+owners[0]);
  // Jira can sort its native field on read. Avoid rewriting an identical membership on every import.
  if (managerId && stored.length>1 && stored.at(-1)!==managerId)
    warnings.add(key+' has all matched owners. Jira displays '+manager+' in its own field order.');
  return {owners,unmatched:owners.filter(n=>!matched.has(n)),assignee:saved.assignee?.displayName || '',stored:field ? (saved[field] ?? []) as User[] : []};
}

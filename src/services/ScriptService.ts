import { z } from 'zod';
import type { Binding } from '../models/messages';
import type { ToolArgs, ToolName } from '../models/tools';
import type { Collection, Page, SearchItem } from '../features/workspace/types';

const id = z.string().regex(/^\d{1,30}$/);
const version = z.number().int().min(1).max(2_147_483_646);
const limit = z.number().int().min(1).max(100).default(20);
const field = z.enum(['storage', 'title']);
const planSchema = z.strictObject({
  format: z.literal('confluence-toolkit-replace-v1'),
  site: z.strictObject({
    origin: z.url(),
    context: z.string(),
    deployment: z.enum(['cloud', 'data-center']),
  }),
  accountId: z.string().min(1),
  field,
  find: z.string().min(1).max(160_000),
  with: z.string().max(160_000),
  pages: z.array(z.strictObject({ pageId: id, expectedVersion: version, matches: z.number().int().positive() })).max(100),
});

export const scriptSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('query'), text: z.string().trim().min(1).optional(), cql: z.string().trim().min(1).optional(),
    limit, cursor: z.string().optional(), start: z.number().int().min(0).max(1_000_000).optional() }),
  z.strictObject({ command: z.literal('select'), pageId: id }),
  z.strictObject({ command: z.literal('change'), pageId: id, expectedVersion: version,
    title: z.string().trim().min(1).max(255).optional(), storage: z.string().max(160_000).optional() }),
  z.strictObject({ command: z.literal('replace'), pageId: id.optional(), cql: z.string().trim().min(1).optional(),
    limit, field: field.default('storage'), find: z.string().min(1).max(160_000), with: z.string().max(160_000) }),
  z.strictObject({ command: z.literal('apply'), plan: planSchema }),
]);

export type Script = z.input<typeof scriptSchema>;
export type ReplacementPlan = z.output<typeof planSchema>;
export type Driver = <K extends ToolName>(tool: K, input: ToolArgs<K>) => Promise<unknown>;
export type LogEntry = { level: 'info' | 'success' | 'error'; message: string; at: number };
type Log = (level: LogEntry['level'], message: string) => void;

function occurrenceCount(value: string, find: string) {
  let count = 0;
  for (let cursor = value.indexOf(find); cursor >= 0; cursor = value.indexOf(find, cursor + find.length)) count++;
  return count;
}

function storageOf(page: Page) {
  return page.body?.storage?.value ?? '';
}

function select(call: Driver, pageId: string): Promise<Page> {
  return call('get_page', { pageId }) as Promise<Page>;
}

export async function queryPages(call: Driver, cql: string, maximum: number, log: Log) {
  const pages = new Set<string>();
  const positions = new Set<string>();
  let pagination: { cursor?: string; start?: number } = {};
  for (;;) {
    const page = await call('search', { cql, ...pagination, limit: Math.min(maximum, 25) }) as Collection<SearchItem>;
    for (const item of page.results) {
      if (item.content?.type === 'page' && item.content.id) pages.add(String(item.content.id));
      if (pages.size === maximum) return [...pages];
    }
    log('info', `Found ${pages.size} candidate pages so far.`);
    pagination = page.nextCursor ? { cursor: page.nextCursor } : page.nextStart !== undefined ? { start: page.nextStart } : {};
    const key = JSON.stringify(pagination);
    if (key === '{}' || positions.has(key)) return [...pages];
    positions.add(key);
    if (positions.size >= 25) throw new Error('Search scanned 25 batches. Narrow the CQL conditions and try again.');
  }
}

export async function executeScriptCommand(call: Driver, input: Script, log: Log = () => {}) {
  const options = scriptSchema.parse(input);
  log('info', `Started ${options.command}.`);
  switch (options.command) {
    case 'query': {
      const { text, cql, limit, cursor, start } = options;
      if (Boolean(text) === Boolean(cql)) throw new Error('Supply either a keyword or a CQL query.');
      if (cursor !== undefined && start !== undefined) throw new Error('Use either a cursor or an offset.');
      const data = await call('search', { text, cql, limit, cursor, start }) as Collection<SearchItem>;
      log('success', `Query returned ${data.results.length} results.`);
      return data;
    }
    case 'select': {
      const page = await select(call, options.pageId);
      log('success', `Selected page ${page.id}, version ${page.version.number}.`);
      return page;
    }
    case 'change': {
      if (options.title === undefined && options.storage === undefined) throw new Error('Supply a title, storage markup, or both.');
      const identity = await call('whoami', {}) as Binding['identity'];
      const page = await select(call, options.pageId);
      if (page.version.number !== options.expectedVersion) {
        throw new Error('The page version changed. Select it again and reconcile your change.');
      }
      const result = await call('update_page', {
        pageId: options.pageId, expectedVersion: options.expectedVersion,
        target: { ...identity.site, accountId: identity.id },
        title: options.title ?? page.title, storage: options.storage ?? storageOf(page),
      }) as Page;
      log('success', `Saved page ${page.id}, version ${result.version?.number ?? 'unknown'}.`);
      return result;
    }
    case 'replace': {
      if (Boolean(options.pageId) === Boolean(options.cql)) throw new Error('Supply either a page ID or a CQL query.');
      if (options.find === options.with) throw new Error('The find and replacement text must differ.');
      const identity = await call('whoami', {}) as Binding['identity'];
      const ids = options.pageId ? [options.pageId] : await queryPages(call, options.cql!, options.limit, log);
      const pages: ReplacementPlan['pages'] = [];
      for (const pageId of ids) {
        const page = await select(call, pageId);
        const matches = occurrenceCount(options.field === 'title' ? page.title : storageOf(page), options.find);
        if (matches) pages.push({ pageId, expectedVersion: page.version.number, matches });
        log('info', `Scanned page ${pageId}, version ${page.version.number}. ${matches} matches.`);
      }
      log('success', `Previewed changes to ${pages.length} of ${ids.length} pages.`);
      return planSchema.parse({
        format: 'confluence-toolkit-replace-v1', site: identity.site, accountId: identity.id,
        field: options.field, find: options.find, with: options.with, pages,
      });
    }
    case 'apply': {
      const { plan } = options;
      if (new Set(plan.pages.map(page => page.pageId)).size !== plan.pages.length || plan.find === plan.with) {
        throw new Error('The plan repeats a page or does not change the matching text.');
      }
      const identity = await call('whoami', {}) as Binding['identity'];
      if (identity.id !== plan.accountId || identity.site?.origin !== plan.site.origin
          || identity.site.context !== plan.site.context || identity.site.deployment !== plan.site.deployment) {
        throw new Error('This plan belongs to a different Confluence site or account.');
      }
      const results = [];
      for (const { pageId, expectedVersion, matches } of plan.pages) {
        try {
          const page = await select(call, pageId);
          const value = plan.field === 'title' ? page.title : storageOf(page);
          if (page.version.number !== expectedVersion || occurrenceCount(value, plan.find) !== matches) {
            throw new Error('The page changed after preview. Generate a fresh plan.');
          }
          const replacement = value.replaceAll(plan.find, () => plan.with);
          const saved = await call('update_page', {
            pageId, expectedVersion, target: { ...plan.site, accountId: plan.accountId },
            title: plan.field === 'title' ? replacement : page.title,
            storage: plan.field === 'storage' ? replacement : storageOf(page),
          }) as Page;
          results.push({ pageId, version: saved.version?.number, matches, updated: true });
          log('success', `Updated page ${pageId}. ${matches} replacements.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ pageId, updated: false, error: message });
          log('error', `Page ${pageId}: ${message}`);
        }
      }
      const updated = results.filter(result => result.updated).length;
      log(updated === results.length ? 'success' : 'error', `Updated ${updated} of ${results.length} planned pages.`);
      return { results };
    }
  }
}

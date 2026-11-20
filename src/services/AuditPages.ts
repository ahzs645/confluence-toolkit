import type { AuditOptions } from '../models/audit';
import type { Reply, Site } from '../models/messages';
import type { ToolArgs, ToolName } from '../models/tools';
import type { Collection, Page, SearchItem } from '../features/workspace/types';

export type AuditCall = <K extends ToolName>(tool: K, input: ToolArgs<K>) => Promise<Reply>;
export type AuditPage = { id: string; title: string };
export type AuditPagination = { cursor?: string; start?: number };
export const cqlQuote = (value: string) => '"' + value.replace(/[\\"]/g, '\\$&') + '"';

export function searchFilter(scope: AuditOptions['scope']) {
  const { space, label, ancestorId, cql } = scope;
  const conditions = ['type = page'];
  if (space) conditions.push('space = ' + cqlQuote(space));
  if (label) conditions.push('label = ' + cqlQuote(label));
  if (ancestorId) conditions.push(`(id = ${ancestorId} OR ancestor = ${ancestorId})`);
  if (cql) conditions.push('(' + cql + ')');
  return conditions.join(' AND ') + ' ORDER BY lastmodified DESC';
}

export async function auditPageBatch(site: Site, call: AuditCall, scope: AuditOptions['scope'],
  pagination: AuditPagination, limit = 50): Promise<Collection<AuditPage>> {
  const directSpace = !scope.ancestorId && !scope.label && !scope.cql
    ? site.deployment === 'cloud' ? scope.spaceId : scope.space
    : undefined;
  if (directSpace) {
    const reply = await call('list_space_pages', { ...pagination, limit, space: directSpace });
    if (!reply.ok) throw new Error(reply.error);
    const page = reply.data as Collection<Page>;
    return { ...page, results: page.results.map(item => ({ id: String(item.id), title: item.title })) };
  }
  const reply = await call('search', { ...pagination, limit, cql: searchFilter(scope) });
  if (!reply.ok) throw new Error(reply.error);
  const page = reply.data as Collection<SearchItem>;
  return { ...page, results: page.results.flatMap(item => item.content?.id && (!item.content.type || item.content.type === 'page')
    ? [{ id: String(item.content.id), title: item.title }] : []) };
}

export async function collectAuditPages(site: Site, call: AuditCall, options: AuditOptions,
  progress: (message: string) => void) {
  const explicit = options.scope.pageIds ?? (options.scope.pageId ? [options.scope.pageId] : undefined);
  if (explicit) return { ids: [...new Set(explicit)], limited: false };
  const ids = new Set<string>();
  const positions = new Set<string>();
  let pagination: AuditPagination = {};
  for (;;) {
    const page = await auditPageBatch(site, call, options.scope, pagination, options.allPages ? 50 : Math.min(50, options.pageLimit));
    for (const item of page.results) {
      if (!options.allPages && ids.size >= options.pageLimit) return { ids: [...ids], limited: true };
      ids.add(item.id);
    }
    progress(`Loaded ${ids.size} pages…`);
    pagination = page.nextCursor ? { cursor: page.nextCursor } : page.nextStart === undefined ? {} : { start: page.nextStart };
    const key = JSON.stringify(pagination);
    if (key === '{}') return { ids: [...ids], limited: false };
    if (positions.has(key)) throw new Error('Confluence repeated a page cursor before the catalog finished loading.');
    if (!options.allPages && ids.size >= options.pageLimit) return { ids: [...ids], limited: true };
    positions.add(key);
  }
}

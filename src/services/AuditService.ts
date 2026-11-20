import type { AuditOptions, AuditReport, Health, LinkHealth, Reference } from '../models/audit';
import type { Reply, Site } from '../models/messages';
import type { ToolArgs, ToolName } from '../models/tools';
import type { Collection, Page, SearchItem } from '../features/workspace/types';
import { collectAuditPages, cqlQuote as quote } from './AuditPages';
import { allowedInternalUrl } from './ReferenceProbe';
import { readReferences } from './StorageReferences';
import { pageIdFromUrl, siteLink } from './sites';

type AuditApi = {
  call<K extends ToolName>(tool: K, input: ToolArgs<K>): Promise<Reply>;
  probe(url: URL, kind: Reference['kind'], internal: boolean): Promise<LinkHealth>;
};
const MAX_ROWS = 5000;
const delayed = (note: string): LinkHealth => ({ status: 'unchecked', note });

function valueFor(reference: Reference) {
  const { target } = reference;
  switch (target.type) {
    case 'url': return target.href;
    case 'anchor': return '#' + target.fragment;
    case 'attachment': return target.pageTitle ? `${target.pageTitle} / ${target.name}` : target.name;
    case 'page': return (target.space ? target.space + ' / ' : '') + target.title + (target.fragment ? '#' + target.fragment : '');
  }
}

function referenceUrl(reference: Reference, pageUrl: string, site: Site): URL | undefined {
  if (reference.target.type !== 'url') return;
  const href = reference.target.href;
  try {
    const withContext = /^\/(?:spaces|display|pages|x|download\/attachments)(?:\/|$)/.test(href) ? siteLink(href, site) : undefined;
    const url = new URL(withContext ?? href, pageUrl);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url;
  } catch { /* Ignore unparseable URLs. */ }
}

function fromReply(reply: Extract<Reply, { ok: false }>): LinkHealth {
  const status = reply.status === 404 || reply.status === 410 ? 'broken'
    : reply.status === 401 || reply.status === 403 ? 'restricted' : 'error';
  return { status, httpStatus: reply.status, note: status === 'broken' ? 'Confluence did not find an accessible resource.' : reply.error };
}

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function checkAnchor(anchors: Set<string>, fragment: string): LinkHealth {
  const decoded = decode(fragment);
  return anchors.has(decoded) ? { status: 'working' }
    : { status: 'broken', note: 'Fragment missing from the stored page. Macros can generate additional anchors.' };
}

export async function runAudit(site: Site, api: AuditApi, options: AuditOptions, signal: AbortSignal,
  progress: (message: string) => void): Promise<AuditReport> {
  const counts: Record<Health, number> = { working: 0, broken: 0, restricted: 0, redirected: 0, error: 0, unchecked: 0 };
  const report: AuditReport = { candidatePages: 0, pages: [], connections: [], scannedPages: 0, references: 0, checkedTargets: 0,
    links: 0, images: 0, counts, domains: [], issues: [], rows: [], limited: false,
    repeated: [], quality: { missingAlt: 0, missingLabels: 0, duplicateAnchors: 0 }, qualityFindings: [] };
  const stats = new Map<string, { domain: string; count: number; broken: number }>();
  const checks = new Map<string, Promise<LinkHealth>>();
  const spaces = new Map<string, Promise<string | undefined>>();
  const repeated = new Map<string, { value: string; references: number; pages: Set<string>; broken: number }>();
  const externalDomains = new Set(options.checks.externalDomains);

  async function lookup<K extends ToolName>(tool: K, input: ToolArgs<K>) {
    signal.throwIfAborted();
    return api.call(tool, input);
  }

  const { ids, limited: pageLimitReached } = await collectAuditPages(site, lookup, options, progress);
  report.candidatePages = ids.length;
  report.limited = pageLimitReached;
  const edges = new Map<string, AuditReport['connections'][number]>();
  if (!ids.length) progress('No pages matched this scope.');

  async function spaceKey(page: Page) {
    if (page.space?.key) return page.space.key;
    if (!page.spaceId) return undefined;
    if (!spaces.has(page.spaceId)) spaces.set(page.spaceId, lookup('get_space', { space: page.spaceId }).then(reply =>
      reply.ok ? (reply.data as { key?: string }).key : undefined));
    return spaces.get(page.spaceId);
  }

  async function pageByTitle(page: Page, title: string, destinationSpace?: string) {
    const space = destinationSpace ?? await spaceKey(page);
    if (!space) return { ok: false, error: 'The source space key was unavailable.' } satisfies Reply;
    const cql = `type = page AND space = ${quote(space)} AND title = ${quote(title)}`;
    const search = await lookup('search', { cql, limit: 10 });
    if (!search.ok) return search;
    const items = (search.data as Collection<SearchItem>).results;
    const targetId = items.find(item => item.title === title && item.content?.type === 'page')?.content?.id;
    return targetId ? { ok: true, data: String(targetId) } as const
      : { ok: false, status: 404, error: 'No page with this title was found in its space.' } as const;
  }

  async function attachment(pageId: string, name: string): Promise<LinkHealth> {
    const reply = await lookup('list_attachments', { pageId, filename: name, limit: 10 });
    if (!reply.ok) return fromReply(reply);
    const existing = (reply.data as Collection<{ title?: string }>).results.some(item => item.title === name);
    return existing ? { status: 'working' } : { status: 'broken', note: 'The attachment was not found on the referenced page.' };
  }

  async function checkTarget(page: Page, anchors: Set<string>, reference: Reference, url: URL | undefined): Promise<LinkHealth> {
    const { target } = reference;
    signal.throwIfAborted();
    if (target.type === 'anchor') return checkAnchor(anchors, target.fragment);
    if (target.type === 'attachment') {
      if (!target.pageTitle) return attachment(page.id, target.name);
      const resolved = await pageByTitle(page, target.pageTitle, target.space);
      return resolved.ok ? attachment(String(resolved.data), target.name) : fromReply(resolved);
    }

    async function checkPage(targetId: string, fragment?: string): Promise<LinkHealth> {
      const loaded = targetId === page.id ? { ok: true, data: page as unknown } as const : await lookup('get_page', { pageId: targetId });
      if (!loaded.ok) return { ...fromReply(loaded), targetPageId: targetId };
      if (!fragment) return { status: 'working', targetPageId: targetId };
      const targetPage = loaded.data as Page;
      const content = targetId === page.id ? anchors : readReferences(targetPage.body?.storage?.value ?? '').anchors;
      return { ...checkAnchor(content, fragment), targetPageId: targetId };
    }

    if (target.type === 'page') {
      const resolved = await pageByTitle(page, target.title, target.space);
      return resolved.ok ? checkPage(String(resolved.data), target.fragment) : fromReply(resolved);
    }
    if (!url) return delayed('Only HTTP and HTTPS references can be checked.');
    if (url.origin === site.origin) {
      const relative = url.pathname.slice(site.context.length);
      if (!allowedInternalUrl(url, site)) return delayed('Outside the connected Confluence content paths.');
      const file = relative.match(/^\/download\/attachments\/(\d+)\/([^/]+)$/);
      if (file) return attachment(file[1], decode(file[2]));
      const id = pageIdFromUrl(url.href, site);
      if (id && /^\d{1,30}$/.test(id) && reference.kind === 'link') return checkPage(id, url.hash.slice(1));
      return api.probe(url, reference.kind, true);
    }
    return api.probe(url, reference.kind, false);
  }

  for (const id of ids) {
    signal.throwIfAborted();
    const reply = await lookup('get_page', { pageId: id });
    if (!reply.ok) {
      report.issues.push({ pageId: id, message: reply.error });
      continue;
    }
    const page = reply.data as Page;
    const storage = page.body?.storage?.value;
    if (typeof storage !== 'string') {
      report.issues.push({ pageId: id, message: 'Page storage markup was unavailable.' });
      continue;
    }
    const pageUrl = siteLink(page._links?.webui, site) ?? `${site.origin}${site.context}/pages/viewpage.action?pageId=${id}`;
    const { references, anchors, duplicateAnchors, limited } = readReferences(storage);
    report.limited ||= limited;
    report.scannedPages++;
    const source = { id, title: page.title, url: pageUrl, references: 0, broken: 0 };
    report.pages.push(source);
    progress(`Scanning page ${id} (${report.scannedPages + report.issues.length}/${ids.length}).`);
    function qualityFinding(check: AuditReport['qualityFindings'][number]['check'], value: string, section?: string) {
      if (report.qualityFindings.length < MAX_ROWS) {
        report.qualityFindings.push({ pageId: id, pageTitle: page.title, pageUrl, value, check, section });
      } else { report.limited = true; }
    }
    if (options.checks.contentQuality) {
      report.quality.duplicateAnchors += duplicateAnchors.size;
      for (const fragment of duplicateAnchors) qualityFinding('Duplicate anchor', '#' + fragment);
    }

    const matching = references.flatMap(reference => {
      const url = referenceUrl(reference, pageUrl, site);
      const internal = reference.target.type !== 'url' || url?.origin === site.origin;
      const domain = url?.hostname ?? (internal ? new URL(site.origin).hostname : 'Other schemes');
      const value = valueFor(reference);
      const f = options.find;
      if (f.type === 'images' && reference.kind !== 'image' || f.type === 'links' && reference.kind !== 'link') return [];
      if (f.location === 'internal' && !internal || f.location === 'external' && (internal || !url)) return [];
      if (f.domain && domain !== f.domain && !(f.includeSubdomains && domain.endsWith('.' + f.domain))) return [];
      if (f.ignoreDomains.some(ignored => domain === ignored || domain.endsWith('.' + ignored))) return [];
      if (f.heading && !reference.section.toLowerCase().includes(f.heading.toLowerCase())) return [];
      if (f.text && !(value + ' ' + reference.label).toLowerCase().includes(f.text.toLowerCase())) return [];
      return [{ reference, url, internal, domain, value }];
    });

    for (let offset = 0; offset < matching.length; offset += 4) {
      signal.throwIfAborted();
      const rows = await Promise.all(matching.slice(offset, offset + 4).map(async candidate => {
        const { reference, url, internal } = candidate;
        let health: LinkHealth = delayed('Status check disabled.');
        if (options.checks.enabled) {
          if (!internal && (!url || url.protocol !== 'https:' || url.port || !externalDomains.has(url.hostname))) {
            health = delayed('External HTTPS checks require selecting this exact domain.');
          } else {
            const key = `${reference.kind}:${url?.href ?? JSON.stringify(reference.target)}${internal && !url ? ' ' + id : ''}`;
            let checked = checks.get(key);
            if (!checked && checks.size < options.checks.targetLimit) {
              checked = checkTarget(page, anchors, reference, url).catch(error => ({
                status: 'error', note: error instanceof Error ? error.message : 'Could not complete the check.',
              }));
              checks.set(key, checked);
            }
            if (checked) health = await checked;
            else { health = delayed('This run reached the limit for distinct checks.'); report.limited = true; }
          }
        }
        return { pageId: id, pageTitle: page.title, pageUrl, ...reference, value: candidate.value, domain: candidate.domain, ...health,
          targetPageId: health.targetPageId ?? pageIdFromUrl(url?.href, site) };
      }));
      for (const row of rows) {
        report.references++;
        source.references++;
        if (row.status === 'broken') source.broken++;
        if (row.targetPageId && row.targetPageId !== id) {
          const key = id + ':' + row.targetPageId;
          const edge = edges.get(key) ?? { sourceId: id, targetId: row.targetPageId, references: 0, broken: 0 };
          edge.references++;
          if (row.status === 'broken') edge.broken++;
          edges.set(key, edge);
        }
        if (row.kind === 'image') report.images++;
        else report.links++;
        counts[row.status]++;
        const summary = stats.get(row.domain) ?? { domain: row.domain, count: 0, broken: 0 };
        summary.count++;
        if (row.status === 'broken') summary.broken++;
        stats.set(row.domain, summary);
        const repeatKey = row.target.type === 'url' ? referenceUrl(row, pageUrl, site)?.href ?? row.value
          : row.target.type === 'page' && row.target.space ? 'page:' + row.value : id + ':' + row.value;
        const existing = repeated.get(repeatKey);
        if (existing || repeated.size < 3000) {
          const target = existing ?? { value: row.value, references: 0, pages: new Set<string>(), broken: 0 };
          target.references++;
          target.pages.add(id);
          if (row.status === 'broken') target.broken++;
          repeated.set(repeatKey, target);
        }
        if (options.checks.contentQuality && row.missingAlt) {
          report.quality.missingAlt++;
          qualityFinding('Missing image alt attribute', row.value, row.section);
        }
        if (options.checks.contentQuality && row.missingLabel) {
          report.quality.missingLabels++;
          qualityFinding('Missing link label', row.value, row.section);
        }
        if (report.rows.length < MAX_ROWS) report.rows.push(row);
        else report.limited = true;
      }
    }
  }
  report.checkedTargets = checks.size;
  report.connections = [...edges.values()];
  report.repeated = Array.from(repeated.values()).filter(target => target.references > 1)
    .map(({ value, pages, references, broken }) => ({ value, pages: pages.size, references, broken }))
    .sort((a, b) => b.pages - a.pages || b.broken - a.broken || b.references - a.references).slice(0, 100);
  report.domains = Array.from(stats.values()).sort((a, b) => b.broken - a.broken || b.count - a.count).slice(0, 100);
  progress(`Scanned ${report.scannedPages} pages and found ${report.references} references.`);
  return report;
}

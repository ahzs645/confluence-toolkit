import type { Site } from '../models/messages';

export function httpsUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.username && !url.password) return url;
  } catch { /* Ignore tabs without an HTTPS document. */ }
}

export function makeSite(rawUrl: string, deployment: unknown, rawContext: unknown): Site {
  const url = httpsUrl(rawUrl);
  if (!url || (deployment !== 'cloud' && deployment !== 'data-center') || typeof rawContext !== 'string') {
    throw new Error('Choose a Confluence tab served over HTTPS.');
  }
  const context = rawContext.trim().replace(/\/$/, '');
  if (!/^(\/[A-Za-z0-9_-]+)*$/.test(context)) {
    throw new Error('Enter a context path such as /wiki or /confluence, or leave it empty for a root installation.');
  }
  const site: Site = { origin: url.origin, context, deployment };
  if (!matchesSite(url.href, site)) {
    throw new Error('The selected tab is outside the specified Confluence context.');
  }
  return site;
}

export function matchesSite(rawUrl: string, site: Site): boolean {
  const url = httpsUrl(rawUrl);
  return !!url && url.origin === site.origin
    && (url.pathname === site.context || url.pathname.startsWith(site.context + '/'));
}

export function siteLink(raw: string | undefined, site: Site): string | undefined {
  if (!raw) return;
  const value = /^\/(?![\/\\])/.test(raw) && site.context
    && !raw.startsWith(site.context + '/') && raw !== site.context
    ? site.context + raw : raw;
  try {
    const url = new URL(value, site.origin);
    return matchesSite(url.href, site) ? url.href : undefined;
  } catch { return undefined; }
}

export function pageIdFromUrl(raw: string | undefined, site: Site) {
  if (!raw || !matchesSite(raw, site)) return;
  const url = new URL(raw);
  const path = url.pathname.slice(site.context.length);
  const id = path.match(/\/pages\/(?:edit-v2\/)?(\d+)(?:\/|$)/)?.[1]
    ?? (path === '/pages/viewpage.action' ? url.searchParams.get('pageId') : undefined);
  return id && /^\d{1,30}$/.test(id) ? id : undefined;
}

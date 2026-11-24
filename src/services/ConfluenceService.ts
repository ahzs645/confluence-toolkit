import type { Site } from '../models/messages';
import { MAX_NATIVE_PAYLOAD, type ToolCall } from '../models/tools';
import { matchesSite, siteLink } from './sites';
import { buildJiraRequest, isJiraCall, type JiraCall } from './JiraService';

type Json = Record<string, any>;
type Query = Record<string, string | number | undefined>;
export type Request = { path: string; query?: Query; method?: string; body?: object | string };

export class ConfluenceError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

function buildRequest(call: Exclude<ToolCall, JiraCall>, cloud: boolean): Request {
  const v1 = '/rest/api';
  const v2 = '/api/v2';
  const input = call.input;
  const pageId = 'pageId' in input ? input.pageId : undefined;
  const content = v1 + '/content';
  const page = cloud ? v2 + '/pages' : content;
  const pagePath = page + '/' + pageId;
  const contentPath = content + '/' + pageId;
  const bodyFormat = { 'body-format': 'storage' };
  const pageQuery = {
    limit: 'limit' in input ? input.limit : undefined,
    cursor: 'cursor' in input ? input.cursor : undefined,
    start: 'start' in input ? input.start : undefined,
  };
  const markup = (value: string) => ({ representation: 'storage', value });

  switch (call.name) {
    case 'whoami':
      return { path: v1 + '/user/current' };
    case 'search': {
      const { text, cql } = call.input;
      if ((text === undefined) === (cql === undefined)) throw new ConfluenceError('Supply either text or CQL.');
      const escaped = text?.replace(/[\\"]/g, '\\$&');
      return { path: v1 + '/search', query: { ...pageQuery, cql: cql ?? `type = page AND text ~ "${escaped}"` } };
    }
    case 'list_spaces':
      return { path: cloud ? v2 + '/spaces' : v1 + '/space', query: pageQuery };
    case 'list_space_pages':
      return cloud
        ? { path: v2 + '/spaces/' + call.input.space + '/pages', query: { ...pageQuery, status: 'current' } }
        : { path: content, query: { ...pageQuery, spaceKey: call.input.space, type: 'page', status: 'current' } };
    case 'get_space':
      return { path: (cloud ? v2 + '/spaces/' : v1 + '/space/') + call.input.space };
    case 'find_page_by_title':
      return { path: page, query: cloud
        ? { ...pageQuery, 'space-id': call.input.space, title: call.input.title, 'status': 'current' }
        : { ...pageQuery, spaceKey: call.input.space, title: call.input.title, type: 'page', status: 'current' } };
    case 'list_versions':
      return { path: cloud ? pagePath + '/versions' : contentPath + '/version', query: pageQuery };
    case 'get_page_version':
      return cloud ? { path: pagePath + '/versions/' + call.input.version }
        : { path: contentPath, query: { version: call.input.version, status: 'historical', expand: 'body.storage,version' } };
    case 'list_inline_comments':
      if (!cloud) throw new ConfluenceError('Inline comments are available through this tool on Confluence Cloud.');
      return { path: pagePath + '/inline-comments', query: { ...pageQuery, ...bodyFormat } };
    case 'update_comment': {
      const { commentId, storage, expectedVersion } = call.input;
      const version = { number: expectedVersion + 1 };
      return cloud ? { path: v2 + '/footer-comments/' + commentId, method: 'PUT', body: { body: markup(storage), version } }
        : { path: content + '/' + commentId, method: 'PUT', body: { type: 'comment', version, body: { storage: markup(storage) } } };
    }
    case 'delete_comment':
      return { path: (cloud ? v2 + '/footer-comments/' : content + '/') + call.input.commentId, method: 'DELETE' };
    case 'get_attachment':
      return { path: cloud ? v2 + '/attachments/' + call.input.attachmentId : content + '/' + call.input.attachmentId };
    case 'list_attachment_versions':
      if (!cloud) throw new ConfluenceError('Attachment version listing is available through this tool on Confluence Cloud.');
      return { path: v2 + '/attachments/' + call.input.attachmentId + '/versions', query: pageQuery };
    case 'list_page_templates':
      if (!cloud) throw new ConfluenceError('This template endpoint is available on Confluence Cloud.');
      return { path: v1 + '/template/page', query: { ...pageQuery, spaceKey: call.input.spaceKey } };
    case 'get_page_template':
      if (!cloud) throw new ConfluenceError('This template endpoint is available on Confluence Cloud.');
      return { path: v1 + '/template/' + call.input.templateId };
    case 'list_ancestors':
      return cloud ? { path: pagePath + '/ancestors', query: { limit: call.input.limit } }
        : { path: contentPath, query: { expand: 'ancestors' } };
    case 'get_space_permissions':
      return cloud
        ? { path: v2 + '/spaces/' + call.input.space + '/permissions', query: pageQuery }
        : { path: v1 + '/space/' + call.input.space, query: { expand: 'permissions' } };
    case 'get_user':
      return { path: v1 + '/user', query: { [cloud ? 'accountId' : 'username']: call.input.user } };
    case 'search_users':
      if (!cloud) throw new ConfluenceError('Search users is available on Confluence Cloud. Use Read Confluence user for Data Center.');
      return { path: v1 + '/search/user', query: { ...pageQuery, cql: call.input.cql } };
    case 'get_page_analytics':
      if (!cloud) throw new ConfluenceError('This analytics endpoint is available on Confluence Cloud.');
      return { path: v1 + '/analytics/content/' + pageId + '/' + call.input.metric, query: { fromDate: call.input.fromDate } };
    case 'create_page_from_template':
      throw new ConfluenceError('Creating from a template requires the selected Confluence tab.');
    case 'trash_attachment':
      if (!cloud) throw new ConfluenceError('Recoverable attachment trash is available through this tool on Confluence Cloud.');
      return { path: v2 + '/attachments/' + call.input.attachmentId, method: 'DELETE' };
    case 'get_content_restrictions':
      return { path: contentPath + '/restriction/byOperation', query: pageQuery };
    case 'get_page':
      return { path: pagePath, query: cloud ? bodyFormat : { expand: 'body.storage,version,space' } };
    case 'list_children':
      return { path: pagePath + (cloud ? '/direct-children' : '/child/page'), query: pageQuery };
    case 'create_page': {
      const { title, storage, parentId, space } = call.input;
      return {
        path: page, method: 'POST',
        body: cloud
          ? { title, spaceId: space, parentId, status: 'current', body: markup(storage) }
          : { title, type: 'page', space: { key: space }, ancestors: parentId ? [{ id: parentId }] : undefined,
              body: { storage: markup(storage) } },
      };
    }
    case 'update_page': {
      const { title, storage, expectedVersion } = call.input;
      const version = { number: expectedVersion + 1 };
      return {
        path: pagePath, method: 'PUT',
        body: cloud
          ? { id: pageId, status: 'current', title, version, body: markup(storage) }
          : { id: pageId, type: 'page', title, version, body: { storage: markup(storage) } },
      };
    }
    case 'trash_page':
      return { path: pagePath, method: 'DELETE', query: cloud ? {} : { status: 'current' } };
    case 'list_comments':
      return cloud
        ? { path: pagePath + '/footer-comments', query: { ...pageQuery, ...bodyFormat } }
        : { path: contentPath + '/child/comment', query: { ...pageQuery, expand: 'body.storage,version' } };
    case 'add_comment': {
      const body = markup(call.input.storage);
      return cloud
        ? { path: v2 + '/footer-comments', method: 'POST', body: { pageId, body } }
        : { path: content, method: 'POST', body: { type: 'comment', container: { id: pageId, type: 'page' }, body: { storage: body } } };
    }
    case 'list_attachments':
      return { path: pagePath + (cloud ? '/attachments' : '/child/attachment'), query: { ...pageQuery, filename: call.input.filename } };
    case 'upload_attachment':
      throw new ConfluenceError('Upload requires the selected Confluence document.');
    case 'list_labels':
      return { path: pagePath + (cloud ? '/labels' : '/label'), query: pageQuery };
    case 'add_label':
      return { path: contentPath + '/label', method: 'POST', body: [{ prefix: 'global', name: call.input.name }] };
    case 'remove_label':
      return { path: contentPath + '/label', method: 'DELETE', query: { name: call.input.name } };
  }
}

async function readText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ConfluenceError('Confluence returned an empty response.');
  const decoder = new TextDecoder();
  let raw = '';
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new ConfluenceError('Response is too large. Try a smaller result limit.');
      raw += decoder.decode(chunk.value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function readJson(response: Response): Promise<Json> {
  const data: unknown = JSON.parse(await readText(response, MAX_NATIVE_PAYLOAD));
  if (!data || typeof data !== 'object') throw new ConfluenceError('Confluence did not return a JSON object.');
  return data as Json;
}

function paging(data: Json, response: Response, requestUrl: URL) {
  const linkHeader = response.headers.get('link');
  const headerNext = linkHeader?.match(/<([^>]+)>\s*;\s*rel="?next"?(?:\s*[,;]|\s*$)/i)?.[1];
  const next = data._links?.next ?? data.links?.next ?? (typeof data.next === 'string' ? data.next : undefined) ?? headerNext;
  if (!next) return {};
  const url = new URL(next, requestUrl);
  if (url.origin !== requestUrl.origin) return {};
  const cursor = url.searchParams.get('cursor');
  const start = url.searchParams.get('start');
  return cursor ? { nextCursor: cursor } : start && /^\d+$/.test(start) ? { nextStart: Number(start) } : {};
}

function normalize(call: ToolCall, data: Json, response: Response, url: URL, site: Site) {
  if (call.name === 'whoami' || call.name === 'jira_whoami') {
    const id = data.accountId || data.userKey || data.username || data.key || data.name;
    if (!id || data.type === 'anonymous' || data.accountType === 'anonymous' || id === 'anonymous') {
      throw new ConfluenceError('Sign in to the selected Atlassian tab and connect again.', 401);
    }
    return { name: data.displayName || data.publicName || data.username || id, id, site };
  }
  if (call.name === 'get_page' && data.type && data.type !== 'page') {
    throw new ConfluenceError('That ID does not refer to a Confluence page.', 404);
  }
  if (call.name === 'get_attachment' || call.name === 'jira_get_attachment') {
    return { ...data, downloadUrl: siteLink(data.downloadLink || data._links?.download || data.content, site) };
  }
  if (isJiraCall(call)) return Array.isArray(data) ? { results: data } : data;
  if (Array.isArray(data.results)) {
    const results = call.name === 'list_attachments'
      ? data.results.map(item => ({
          ...item, downloadUrl: siteLink(item.downloadLink || item._links?.download, site),
        }))
      : data.results;
    return { results, ...paging(data, response, url) };
  }
  return data;
}

export async function runConfluenceTool(site: Site, call: ToolCall): Promise<unknown> {
  if (!matchesSite(location.href, site)) throw new ConfluenceError('The Confluence tab changed. Connect it again.');
  if (isJiraCall(call) !== (site.product === 'jira')) throw new ConfluenceError('Connect the correct Atlassian product first.');
  const cloud = site.deployment === 'cloud';
  const request = isJiraCall(call) ? buildJiraRequest(call, cloud) : buildRequest(call, cloud);
  const url = new URL(site.context + request.path, site.origin);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers = new Headers({ Accept: 'application/json' });
  let body: BodyInit | undefined;
  if (request.body) {
    body = JSON.stringify(request.body);
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method ?? 'GET', body, headers,
      mode: 'same-origin', credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    const advice = request.method ? 'Check Confluence for the outcome before repeating the write.' : 'Check the tab and try again.';
    throw new ConfluenceError('Confluence did not complete the request. ' + advice);
  }

  if (response.type === 'opaqueredirect' || response.status === 401) {
    throw new ConfluenceError('Confluence requested sign-in or returned a redirect. Check the selected tab and context path.', 401);
  }
  if (!response.ok) {
    const versionError = call.name === 'update_page' && (response.status === 400 || response.status === 409)
      ? await readJson(response).catch(() => undefined) : undefined;
    if (response.status === 409 || (versionError && /version.*(conflict|increment|mismatch|current|number)/i.test(JSON.stringify(versionError)))) {
      throw new ConfluenceError('Confluence reported a version conflict. Read the current page and reconcile your edits.', 409);
    }
    const messages: Record<number, string> = {
      403: 'Confluence denied access. Check your Confluence account permissions.',
      404: 'Confluence did not find this resource. Check the deployment, context path, and ID.',
      429: 'Confluence is rate limiting requests. Wait before trying again.',
    };
    throw new ConfluenceError(messages[response.status] ?? `Confluence returned HTTP ${response.status}.`, response.status);
  }
  // Jira confirms a created issue link with HTTP 201 and an empty body.
  if (call.name === 'jira_link_issues' && response.status === 201) return {};
  if (response.status === 204) return { pageId: 'pageId' in call.input ? call.input.pageId : undefined };
  if (!/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
    throw new ConfluenceError('Confluence returned a non-JSON page. Check sign-in and the context path.');
  }
  return normalize(call, await readJson(response), response, url, site);
}

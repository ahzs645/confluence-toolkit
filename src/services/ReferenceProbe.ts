import type { LinkHealth } from '../models/audit';
import type { Site } from '../models/messages';

export function allowedInternalUrl(url: URL, site: Site) {
  if (url.origin !== site.origin || url.username || url.password || !url.pathname.startsWith(site.context + '/')) return false;
  const path = url.pathname.slice(site.context.length);
  return /^\/(?:spaces|display|pages|x|images|download\/attachments|attachments)(?:\/|$)/.test(path);
}

export async function probeReference(url: URL, kind: 'link' | 'image', internal: boolean): Promise<LinkHealth> {
  const options: RequestInit = {
    credentials: internal ? 'same-origin' : 'omit',
    mode: internal ? 'same-origin' : 'cors',
    redirect: 'manual',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(5500),
  };
  try {
    let response = await fetch(url, { ...options, method: 'HEAD' });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { ...options, method: 'GET', headers: { Range: 'bytes=0-0' } });
      void response.body?.cancel().catch(() => {});
    }

    const httpStatus = response.status || undefined;
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return { status: 'redirected', httpStatus, note: 'Redirect destination was not checked.' };
    }
    if (response.ok) {
      const type = response.headers.get('content-type') ?? '';
      if (kind === 'image' && /^(?:text\/html|application\/json|text\/plain)\b/i.test(type)) {
        return { status: 'broken', httpStatus, note: 'The URL returned a document instead of an image.' };
      }
      return { status: 'working', httpStatus };
    }
    if (response.status === 404 || response.status === 410) return { status: 'broken', httpStatus };
    if (response.status === 401 || response.status === 403) return { status: 'restricted', httpStatus };
    return { status: 'error', httpStatus, note: response.status === 429 ? 'The host rate-limited the check.' : 'Unexpected HTTP response.' };
  } catch {
    return { status: 'error', note: 'The browser could not reach the URL or confirm its status.' };
  }
}

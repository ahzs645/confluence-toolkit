import type { Reply, Site } from '../models/messages';
import type { ToolCall } from '../models/tools';

type Upload = Extract<ToolCall, { name: 'upload_attachment' }>['input'];

// Chrome serializes this function into the selected document. Keep it self-contained.
export async function uploadInConfluenceDocument(site: Site, input: Upload, maxBytes: number): Promise<Reply> {
  if (location.origin !== site.origin
      || !(location.pathname === site.context || location.pathname.startsWith(site.context + '/'))) {
    return { ok: false, error: 'The selected tab changed. Connect it again.' };
  }
  const decoded = atob(input.dataBase64);
  if (decoded.length > maxBytes) return { ok: false, error: 'The file exceeds 512 KiB.' };
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(decoded, char => char.charCodeAt(0))], { type: input.contentType }), input.filename);
  const url = site.context + '/rest/api/content/' + input.pageId + '/child/attachment';
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'manual',
      signal: AbortSignal.timeout(25_000),
      headers: { Accept: 'application/json', 'X-Atlassian-Token': 'nocheck' },
      body: form,
    });
    if (response.type === 'opaqueredirect' || response.status === 401) {
      return { ok: false, status: 401, error: 'Confluence requested sign-in. Sign in and reconnect the tab.' };
    }
    if (response.status === 403) {
      return { ok: false, status: 403, error: 'Confluence denied this upload. Check Add Attachments permission or upload from the Confluence editor.' };
    }
    if (response.status === 409) {
      return { ok: false, status: 409, error: 'An attachment with this name already exists.' };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: `Confluence upload returned HTTP ${response.status}.` };
    }
    if (!response.headers.get('content-type')?.includes('json')) {
      return { ok: false, error: 'Verify the upload in the attachment list before sending the file again.' };
    }
    const data = await response.json();
    return {
      ok: true,
      data: { pageId: input.pageId, filename: input.filename, results: Array.isArray(data?.results) ? data.results : [] },
    };
  } catch {
    return { ok: false, error: 'The browser could not confirm the upload. Check the attachment list before sending the file again.' };
  }
}

// Select a file through Confluence's own media picker. The picker handles
// upload, server authorization and draft state in the signed-in browser.
export function stageEditorFile(expectedUrl: string, input: Upload): 'waiting' | 'staged' | 'unexpected' {
  if (location.origin + location.pathname !== expectedUrl) return 'unexpected';
  const editor = document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"], #ak-editor-textarea[contenteditable="true"]');
  if (!editor || !editor.getClientRects().length) return 'waiting';

  const labels = (item: HTMLElement) => [item.getAttribute('aria-label'), item.title, item.textContent?.trim(),
    item.getAttribute('data-tooltip-content')].map(label => label?.toLowerCase() ?? '');
  const buttons = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')];
  const chooseFile = buttons.find(item => labels(item).includes('choose a file') && item.getClientRects().length > 0);
  const modal = chooseFile?.closest('[role="dialog"]') ?? (chooseFile ? document.querySelector('[role="dialog"]') : undefined);
  const picker = modal?.querySelector<HTMLInputElement>('input[type="file"]')
    ?? document.querySelector<HTMLInputElement>('input[type="file"][data-testid="media-picker-file-input"]');
  if (!picker) {
    const state = globalThis as typeof globalThis & { confluenceToolkitOpenedPicker?: boolean };
    const uploadButton = buttons.find(item => labels(item).some(label => label.includes('add image, video, or file'))
      && !item.hasAttribute('disabled') && item.getClientRects().length > 0);
    if (!state.confluenceToolkitOpenedPicker && uploadButton && !chooseFile) {
      state.confluenceToolkitOpenedPicker = true;
      uploadButton.click();
    }
    return 'waiting';
  }

  const bytes = Uint8Array.from(atob(input.dataBase64), char => char.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], input.filename, { type: input.contentType || 'application/octet-stream' }));
  picker.files = transfer.files;
  picker.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return 'staged';
}

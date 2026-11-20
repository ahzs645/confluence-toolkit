import { useEffect, useState, type FormEvent } from 'react';
import type { Site } from '../../models/messages';
import { MAX_ATTACHMENT_BYTES } from '../../models/tools';
import { runTool } from '../../services/ExtensionCommunicationService';
import { siteLink } from '../../services/sites';
import type { Collection, Page, RelatedItem } from './types';

const sections = {
  Children: 'list_children',
  Comments: 'list_comments',
  Attachments: 'list_attachments',
  Labels: 'list_labels',
} as const;
export type Section = keyof typeof sections;

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read this file.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export function RelatedPanel({ section, page, site, openPage }: {
  section: Section;
  page: Page;
  site: Site;
  openPage: (id: string) => void;
}) {
  const [items, setItems] = useState<Collection<RelatedItem>>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [uploadNotice, setUploadNotice] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File>();
  const [fileVersion, setFileVersion] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [next, setNext] = useState<{ cursor?: string; start?: number }>({});
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  useEffect(() => {
    let current = true;
    void runTool<Collection<RelatedItem>>(sections[section], { pageId: page.id, ...next }).then(result => {
      if (current) setItems(result);
    }, error => {
      if (current) setError(error.message);
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, [section, page.id, refresh, next]);

  function reload() {
    setNext({});
    setRefresh(count => count + 1);
  }

  async function change(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (section === 'Comments') await runTool('add_comment', { pageId: page.id, storage: text });
      if (section === 'Labels') await runTool('add_label', { pageId: page.id, name: text });
      if (section === 'Attachments' && file) {
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Choose a file up to 512 KiB.');
        setUploadNotice('');
        const result = await runTool<{ status?: string }>('upload_attachment', {
          pageId: page.id, filename: file.name, contentType: file.type || undefined, dataBase64: await readFile(file),
        });
        setUploadNotice(result.status === 'review_in_editor'
          ? 'Review the file in the opened Confluence editor. Publish the draft if needed.'
          : 'Attachment uploaded.');
        setFile(undefined);
        setFileVersion(value => value + 1);
      }
      setText('');
      reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  async function removeLabel(name: string) {
    setBusy(true);
    setError('');
    try {
      await runTool('remove_label', { pageId: page.id, name });
      setPendingRemoval(undefined);
      reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  return <div className="stack related">
    {error && <div className="error" role="alert">{error}</div>}
    {uploadNotice && <p role="status" className="notice">{uploadNotice}</p>}
    {busy && <p role="status">Loading {section.toLowerCase()}…</p>}
    {!busy && items && !items.results.length && <p className="muted">No {section.toLowerCase()} on this page.</p>}
    {!!items?.results.length && <ul className="related-list">{items.results.map((item, index) => {
      const link = siteLink(item.downloadUrl, site);
      const name = item.name ?? item.title ?? String(item.id);
      return <li key={item.id ?? item.name ?? index}>
        {section === 'Children' && (!item.type || item.type === 'page')
          ? <button className="link-button" onClick={() => openPage(String(item.id))}>{name}</button>
          : section === 'Comments'
            ? <pre className="markup">{item.body?.storage?.value || 'Comment ' + item.id}</pre>
            : link
              ? <a href={link} target="_blank" rel="noreferrer">{name}</a>
              : <span>{name}</span>}
        {section === 'Labels' && item.name && (!item.prefix || item.prefix === 'global') &&
          <button className="text-button" disabled={busy} onClick={() => {
            if (pendingRemoval === item.name) void removeLabel(item.name!);
            else setPendingRemoval(item.name);
          }}>{pendingRemoval === item.name ? 'Confirm removal' : 'Remove'}</button>}
      </li>;
    })}</ul>}
    {(items?.nextCursor || items?.nextStart !== undefined) &&
      <button type="button" disabled={busy} onClick={() => {
        setBusy(true);
        setError('');
        setNext({ cursor: items.nextCursor, start: items.nextStart });
      }}>Next results</button>}
    {section !== 'Children' && <form onSubmit={change} className="stack related-form">
      {section === 'Comments' && <label>Comment storage markup
        <textarea rows={3} value={text} onChange={event => setText(event.target.value)} required />
      </label>}
      {section === 'Labels' && <label>Label name
        <input value={text} onChange={event => setText(event.target.value)} pattern="[a-z0-9_\-]+" required />
      </label>}
      {section === 'Attachments' && <label>Attachment (up to 512 KiB)
        <input type="file" key={fileVersion} onChange={event => setFile(event.target.files?.[0])} required />
      </label>}
      <button type="submit" className="primary" disabled={busy || (section === 'Attachments' ? !file : !text.trim())}>
        {section === 'Attachments' ? 'Upload attachment' : section === 'Labels' ? 'Add label' : 'Add comment'}
      </button>
    </form>}
  </div>;
}

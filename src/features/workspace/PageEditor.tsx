import { useState, type FormEvent } from 'react';
import type { Site } from '../../models/messages';
import { runTool } from '../../services/ExtensionCommunicationService';
import { siteLink } from '../../services/sites';
import { RelatedPanel, type Section } from './RelatedPanel';
import type { Page } from './types';

const sections = ['Page', 'Children', 'Comments', 'Attachments', 'Labels'] as const;

export function PageEditor({ page, site, openPage, onSave, onTrash, createChild }: {
  page: Page;
  site: Site;
  openPage: (id: string) => void;
  onSave: (page: Page) => void;
  onTrash: () => void;
  createChild: (space: string, parentId: string) => void;
}) {
  const [section, setSection] = useState<Section | 'Page'>('Page');
  const [title, setTitle] = useState(page.title);
  const [storage, setStorage] = useState(page.body?.storage?.value ?? '');
  const [editing, setEditing] = useState(false);
  const [trash, setTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const space = String(page.spaceId ?? page.space?.key ?? '');
  const link = siteLink(page._links?.webui ?? (site.deployment === 'cloud' ? '/pages/viewpage.action?pageId=' + page.id : undefined), site);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await runTool<Page>('update_page', { pageId: page.id, expectedVersion: page.version.number, title, storage });
      onSave({ ...page, ...saved, body: { storage: { value: storage } } });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function trashPage() {
    setBusy(true);
    setError('');
    try {
      await runTool('trash_page', { pageId: page.id, confirm: true });
      onTrash();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  return <>
    <div className="editor-header">
      <div><h2>{page.title}</h2><p>Page {page.id} · Version {page.version?.number ?? '—'}</p></div>
      {link && <a href={link} target="_blank" rel="noreferrer">Open in Confluence ↗</a>}
    </div>
    <nav className="section-tabs" aria-label="Page tools">{sections.map(name => <button key={name} type="button"
      aria-pressed={section === name} disabled={busy} onClick={() => setSection(name)}>{name}</button>)}</nav>
    {section !== 'Page'
      ? <RelatedPanel key={section} page={page} site={site} section={section} openPage={openPage} />
      : <div className="stack editor-body">
          {error && <div className="error" role="alert">{error}</div>}
          {editing
            ? <form onSubmit={save} className="stack">
                <label>Page title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={255} required /></label>
                <label>Storage markup<textarea className="code-input" rows={10} value={storage}
                  onChange={event => setStorage(event.target.value)} maxLength={160000} spellCheck={false} /></label>
                <div className="actions">
                  <button className="primary" disabled={busy || (!title.trim()) || (title === page.title && storage === (page.body?.storage?.value ?? ''))}>
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
                </div>
              </form>
            : <>
                <div className="actions">
                  <button className="primary" disabled={busy || !page.version?.number} onClick={() => {
                    setTitle(page.title); setStorage(page.body?.storage?.value ?? ''); setEditing(true); setTrash(false);
                  }}>Edit page</button>
                  <button disabled={busy || !space} onClick={() => createChild(space, page.id)}>Create child</button>
                  <button className="text-button danger" disabled={busy} onClick={() => setTrash(!trash)}>Move to trash</button>
                </div>
                {trash && <div className="confirm" role="group" aria-label="Confirm moving page to trash">
                  <p>Move “{page.title}” to the Confluence trash?</p>
                  <div className="actions"><button className="danger" disabled={busy} onClick={() => void trashPage()}>Confirm trash</button>
                  <button disabled={busy} onClick={() => setTrash(false)}>Cancel</button></div>
                </div>}
                <h3>Storage markup</h3>
                <pre className="markup page-markup">{page.body?.storage?.value || 'This page has no storage markup.'}</pre>
              </>}
        </div>}
  </>;
}

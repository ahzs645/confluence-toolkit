import { useState, type FormEvent } from 'react';
import type { Binding } from '../../models/messages';
import { runTool } from '../../services/ExtensionCommunicationService';
import { pageIdFromUrl, siteLink } from '../../services/sites';
import { PageEditor } from './PageEditor';
import type { Collection, Page, SearchItem, Space } from './types';

type CreateTarget = { space: string; parentId: string };
type Search = { text: string } | { cql: string };
type Pagination = { cursor?: string; start?: number };

export function Workspace({ binding, tabUrl }: { binding: Binding; tabUrl?: string }) {
  const [mode, setMode] = useState<'text' | 'cql'>('text');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>();
  const [found, setFound] = useState<Collection<SearchItem>>();
  const [spaces, setSpaces] = useState<Collection<Space>>();
  const [navigation, setNavigation] = useState<'search' | 'spaces'>('search');
  const [pageId, setPageId] = useState('');
  const [page, setPage] = useState<Page>();
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<CreateTarget>();
  const [notice, setNotice] = useState('');
  const [browseBusy, setBrowseBusy] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const [pageError, setPageError] = useState('');
  const currentId = pageIdFromUrl(tabUrl, binding.site);
  const { site } = binding;

  async function find(criteria: Search, pagination: Pagination = {}) {
    setBrowseBusy(true);
    setBrowseError('');
    setNavigation('search');
    try {
      setFound(await runTool<Collection<SearchItem>>('search', { ...criteria, ...pagination, limit: 20 }));
      setSearch(criteria);
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally { setBrowseBusy(false); }
  }

  async function listSpaces(pagination: Pagination = {}) {
    setBrowseBusy(true);
    setBrowseError('');
    setNavigation('spaces');
    try {
      setSpaces(await runTool<Collection<Space>>('list_spaces', { ...pagination, limit: 25 }));
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally { setBrowseBusy(false); }
  }

  async function openPage(id: string) {
    setPageBusy(true);
    setPageError('');
    setNotice('');
    try {
      const loaded = await runTool<Page>('get_page', { pageId: id });
      setTarget(undefined);
      setPageId(loaded.id);
      setPage(loaded);
      setRevision(value => value + 1);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally { setPageBusy(false); }
  }

  function createPage(space = '', parentId = '') {
    setPageError('');
    setNotice('');
    setTarget({ space, parentId });
  }

  return <div className="workspace">
    <section className="card browser-card" aria-label="Browse Confluence">
      <div className="section-header">
        <div><h2>Browse Confluence</h2><p>Find pages across the spaces you can access.</p></div>
        <button type="button" className="text-button" disabled={browseBusy} onClick={() => void listSpaces()}>List spaces</button>
      </div>
      <form className="search-form" onSubmit={event => {
        event.preventDefault();
        if (query.trim()) void find(mode === 'text' ? { text: query } : { cql: query });
      }}>
        <label className="search-field">Search
          <input type="search" placeholder={mode === 'text' ? 'Search pages' : 'type = page AND …'} value={query}
            maxLength={mode === 'text' ? 1000 : 3000} onChange={event => setQuery(event.target.value)} required />
        </label>
        <label>Query type<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
          <option value="text">Keyword</option><option value="cql">CQL</option>
        </select></label>
        <button className="primary" disabled={browseBusy || !query.trim()}>Search</button>
      </form>
      <form className="id-form" onSubmit={event => { event.preventDefault(); void openPage(pageId.trim()); }}>
        <label>Page ID<input inputMode="numeric" value={pageId} onChange={event => setPageId(event.target.value)} placeholder="Enter page ID"
          pattern="[0-9]+" required /></label>
        <button disabled={pageBusy || !!target || !pageId.trim()}>Open by ID</button>
      </form>
      <div className="actions browser-actions">
        <button type="button" onClick={() => createPage()} disabled={pageBusy || !!target}>New page</button>
        {currentId && <button type="button" className="text-button" disabled={pageBusy || !!target} onClick={() => void openPage(currentId)}>Open current page</button>}
      </div>
      {browseError && <div className="error" role="alert">{browseError}</div>}
      {browseBusy && <p role="status">Loading…</p>}
      {navigation === 'search' && found &&
        <div className="result-region">
          <h3>Search results</h3>
          {found.results.length ? <ul className="results">{found.results.map((item, index) => {
            const link = siteLink(item.url, site);
            return <li key={item.content?.id ?? index}>
              {item.content?.id && (!item.content.type || item.content.type === 'page')
                ? <button type="button" disabled={pageBusy || !!target} className="link-button" onClick={() => void openPage(String(item.content!.id))}>{item.title}</button>
                : link ? <a href={link} target="_blank" rel="noreferrer">{item.title}</a> : <span>{item.title}</span>}
              {item.excerpt && <p>{item.excerpt.replaceAll(/@@@(?:hl|endhl)@@@/g, '')}</p>}
            </li>;
          })}</ul> : <p>No matching pages.</p>}
          {search && (found.nextCursor || found.nextStart !== undefined) &&
            <button disabled={browseBusy} onClick={() => void find(search, { cursor: found.nextCursor, start: found.nextStart })}>Next results</button>}
        </div>}
      {navigation === 'spaces' && spaces &&
        <div className="result-region">
          <h3>Spaces</h3>
          {spaces.results.length ? <ul className="results">{spaces.results.map(space => <li key={space.key}>
            <strong>{space.name}</strong><p>{space.key}</p>
            <button type="button" className="text-button" disabled={pageBusy || !!target}
              onClick={() => createPage(site.deployment === 'cloud' ? String(space.id) : space.key)}>New page in this space</button>
          </li>)}</ul> : <p>No accessible spaces found.</p>}
          {(spaces.nextCursor || spaces.nextStart !== undefined) &&
            <button disabled={browseBusy} onClick={() => void listSpaces({ cursor: spaces.nextCursor, start: spaces.nextStart })}>Next spaces</button>}
        </div>}
    </section>
    <section className="card document-card" aria-label="Page workspace">
      {pageError && <div className="error document-message" role="alert">{pageError}</div>}
      {notice && <p className="notice document-message" role="status">{notice}</p>}
      {pageBusy
        ? <p className="empty-workspace" role="status">Opening page…</p>
        : target
          ? <CreatePage target={target} site={site} cancel={() => setTarget(undefined)} onCreate={async created => {
            setTarget(undefined);
            await openPage(created.id);
            setNotice('Page created.');
          }} />
          : page
            ? <PageEditor key={revision} page={page} site={site}
              openPage={id => void openPage(id)} createChild={createPage}
              onSave={updated => { setPage(updated); setRevision(value => value + 1); setNotice('Page saved.'); }}
              onTrash={() => { setPage(undefined); setPageId(''); setNotice('Page moved to trash.'); }} />
            : <div className="empty-workspace"><span className="empty-icon" aria-hidden="true">▤</span>
              <h2>Page workspace</h2><p>Open a search result or enter a page ID to see its content and tools.</p></div>}
    </section>
  </div>;
}

function CreatePage({ site, target, cancel, onCreate }: {
  site: Binding['site'];
  target: CreateTarget;
  cancel: () => void;
  onCreate: (page: Page) => Promise<void>;
}) {
  const [space, setSpace] = useState(target.space);
  const [parentId, setParentId] = useState(target.parentId);
  const [title, setTitle] = useState('');
  const [storage, setStorage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await runTool<Page>('create_page', { space: space.trim(), parentId: parentId.trim() || undefined, title, storage });
      await onCreate(created);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <div className="editor-body stack">
    <div><h2>New Confluence page</h2><p>The page will be published in the selected space.</p></div>
    {error && <div className="error" role="alert">{error}</div>}
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        <label>{site.deployment === 'cloud' ? 'Space ID' : 'Space key'}
          <input value={space} onChange={event => setSpace(event.target.value)} required />
        </label>
        <label>Parent page ID (optional)<input inputMode="numeric" pattern="[0-9]+" value={parentId} onChange={event => setParentId(event.target.value)} /></label>
      </div>
      <label>Page title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={255} required /></label>
      <label>Storage markup<textarea className="code-input" rows={8} value={storage} onChange={event => setStorage(event.target.value)} maxLength={160000} spellCheck={false} /></label>
      <div className="actions">
        <button className="primary" disabled={busy || !space.trim() || !title.trim()}>{busy ? 'Publishing…' : 'Publish page'}</button>
        <button type="button" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
    </form>
  </div>;
}

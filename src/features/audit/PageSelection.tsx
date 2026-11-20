import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditOptions } from '../../models/audit';
import type { Binding } from '../../models/messages';
import type { AuditPage } from '../../services/AuditPages';
import { request } from '../../services/ExtensionCommunicationService';
import { pageIdFromUrl } from '../../services/sites';
import type { Collection } from '../workspace/types';

export function PageSelection({ binding, scope, tabUrl, selected, onSelect }: {
  binding: Binding; scope: AuditOptions['scope']; tabUrl?: string;
  selected: string[]; onSelect: (ids: string[]) => void;
}) {
  const [pages, setPages] = useState<Collection<AuditPage>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(true);
  const [catalogScope, setCatalogScope] = useState<AuditOptions['scope']>();
  const atEnd = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const cursors = useRef(new Set<string>());
  const current = pageIdFromUrl(tabUrl, binding.site);
  const hasMore = !!pages?.nextCursor || pages?.nextStart !== undefined;

  const load = useCallback(async (criteria: AuditOptions['scope'], more?: Collection<AuditPage>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await request<Collection<AuditPage>>({
        type: 'audit:pages', documentId: binding.documentId, scope: criteria, cursor: more?.nextCursor, start: more?.nextStart,
      });
      const cursor = next.nextCursor ?? next.nextStart;
      if (cursor !== undefined && cursors.current.has(String(cursor))) {
        next.nextCursor = undefined;
        next.nextStart = undefined;
        setError('Confluence repeated a cursor. Review the pages already loaded.');
      } else if (cursor !== undefined) { cursors.current.add(String(cursor)); }
      setPages(previous => {
        const merged = new Map((more ? previous?.results ?? [] : []).map(page => [page.id, page]));
        for (const page of next.results) merged.set(page.id, page);
        return { ...next, results: [...merged.values()] };
      });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  }, [binding.documentId]);

  useEffect(() => {
    if (!auto || !hasMore || !pages || !catalogScope || busy || error || !atEnd.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void load(catalogScope, pages);
    }, { root: container.current });
    observer.observe(atEnd.current);
    return () => observer.disconnect();
  }, [auto, hasMore, pages, catalogScope, busy, error, load]);

  function set(id: string, checked: boolean) {
    onSelect(checked ? [...new Set([...selected, id])].slice(0, 1000) : selected.filter(item => item !== id));
  }

  return <details className="audit-advanced">
    <summary>Query and select pages{selected.length ? ` (${selected.length})` : ''}</summary>
    <div className="stack details-body">
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => {
          cursors.current.clear();
          setCatalogScope(scope);
          setPages(undefined);
          onSelect([]);
          void load(scope);
        }}>Load matching pages</button>
        {current && <button type="button" onClick={() => set(current, true)}>Select current page</button>}
      </div>
      {current && <p>Current Confluence page · {current}</p>}
      {pages && <>
        <div className="actions">
          <button type="button" onClick={() => onSelect([...new Set([...selected, ...pages.results.map(page => page.id)])].slice(0, 1000))}>Select loaded</button>
          <button type="button" disabled={!selected.length} onClick={() => onSelect([])}>Clear selection</button>
        </div>
        <p role="status">{pages.results.length} pages loaded · {selected.length} selected</p>
        <label className="checkbox"><input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} /> Load more as I scroll</label>
        <div className="page-picker" ref={container} tabIndex={0} aria-label="Matching pages">
          {pages.results.map(page => <label className="checkbox picker-row" key={page.id}>
            <input type="checkbox" checked={selected.includes(page.id)} onChange={event => set(page.id, event.target.checked)} />
            <span>{page.title} <small>Page {page.id}{page.id === current ? ' · Current' : ''}</small></span>
          </label>)}
          <div ref={atEnd} aria-hidden="true" className="picker-end" />
        </div>
        {hasMore && catalogScope && <button type="button" disabled={busy} onClick={() => void load(catalogScope, pages)}>Load next page batch</button>}
      </>}
      {busy && <p role="status">Loading pages…</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  </details>;
}

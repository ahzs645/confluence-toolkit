import { useState } from 'react';
import type { AuditReport } from '../../models/audit';
import { linkRepairSchema, type LinkRule, type RepairPlan, type RepairResults } from '../../models/linkRepair';
import type { Binding } from '../../models/messages';
import { request } from '../../services/ExtensionCommunicationService';
import { pageIdFromUrl } from '../../services/sites';
import type { Collection, SearchItem } from '../workspace/types';

function brokenDestinations(report: AuditReport) {
  const groups = new Map<string, Omit<LinkRule, 'to'> & { occurrences: number }>();
  for (const row of report.rows) {
    if (row.status !== 'broken' || (row.target.type !== 'url' && row.target.type !== 'anchor')) continue;
    const key = row.kind + ':' + row.value;
    const group = groups.get(key) ?? { from: row.value, kind: row.kind, pageIds: [], occurrences: 0 };
    if (!group.pageIds.includes(row.pageId)) group.pageIds.push(row.pageId);
    group.occurrences++;
    groups.set(key, group);
  }
  return groups;
}

export function LinkRepairPanel({ report, binding, tabUrl }: { report: AuditReport; binding: Binding; tabUrl?: string }) {
  const groups = brokenDestinations(report);
  const [source, setSource] = useState(groups.keys().next().value ?? '');
  const [destination, setDestination] = useState('');
  const [rules, setRules] = useState<LinkRule[]>([]);
  const [plan, setPlan] = useState<RepairPlan>();
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<RepairResults>();
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState<SearchItem[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = pageIdFromUrl(tabUrl, binding.site);
  const documentId = binding.documentId;
  const matches = groups.get(source);
  const updatedCount = results?.results.filter(item => item.status === 'updated').length ?? 0;

  function choosePage(id: string) {
    setDestination(`${binding.site.origin}${binding.site.context}/pages/viewpage.action?pageId=${id}`);
  }

  async function findReplacement() {
    if (!searchText.trim()) return;
    setBusy(true);
    setError('');
    try {
      const data = await request<Collection<SearchItem>>({
        type: 'tool', documentId, tool: 'search', input: { text: searchText, limit: 15 },
      });
      setSearch(data.results.filter(item => item.content?.id && item.content.type === 'page'));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function mapping(): LinkRule | undefined {
    if (!matches || !destination.trim()) return;
    const { kind, from, pageIds } = matches;
    return { kind, from, pageIds, to: destination };
  }

  function addRule() {
    const pending = mapping();
    if (!pending) return;
    const checked = linkRepairSchema.safeParse({ rules: [pending] });
    if (!checked.success) { setError(checked.error.issues[0].message); return; }
    setRules([...rules.filter(rule => rule.kind !== pending.kind || rule.from !== pending.from), checked.data.rules[0]]);
    setDestination('');
    setPlan(undefined);
    setError('');
  }

  async function preview() {
    setBusy(true);
    setError('');
    setResults(undefined);
    setPlan(undefined);
    try {
      const pending = mapping();
      const input = linkRepairSchema.parse({ rules: pending
        ? [...rules.filter(rule => rule.kind !== pending.kind || rule.from !== pending.from), pending] : rules });
      const next = await request<RepairPlan>({ type: 'repair:preview', documentId, input });
      setPlan(next);
      setSelected(next.pages.map(page => page.pageId));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!plan || !selected.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await request<RepairResults>({
        type: 'repair:apply', documentId, input: { planId: plan.id, pageIds: selected },
      });
      setResults(next);
      setPlan(undefined);
      setSelected([]);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <details className="audit-advanced">
    <summary>Bulk link repair</summary>
    <div className="stack details-body">
      {!groups.size ? <p>This report has no broken URL findings available for repair.</p> : <>
        <p>Choose replacement URLs for broken destinations. The preview lists exact attributes on each page.</p>
        <fieldset className="stack script-fields" disabled={busy}>
          <label htmlFor="repair-source">Broken destination</label>
          <select id="repair-source" value={source} onChange={event => {
            setSource(event.target.value); setDestination(''); setPlan(undefined);
          }}>
            {[...groups].map(([key, item]) => <option key={key} value={key}>{item.from} · {item.pageIds.length} pages</option>)}
          </select>
          <label>Replacement URL<input value={destination} placeholder="https://…"
            onChange={event => { setDestination(event.target.value); setPlan(undefined); }} /></label>
          {current && <button type="button" onClick={() => { choosePage(current); setPlan(undefined); }}>Use current page as destination</button>}
          <details>
            <summary>Find a Confluence page for the replacement</summary>
            <div className="stack details-body">
              <label>Replacement page search<input value={searchText} onChange={event => setSearchText(event.target.value)} /></label>
              <button type="button" onClick={() => void findReplacement()} disabled={!searchText.trim()}>Search replacement pages</button>
              {search && (search.length ? <ul className="results">{search.map(item => <li key={item.content!.id}>
                <button className="link-button" type="button" onClick={() => { choosePage(String(item.content!.id)); setPlan(undefined); }}>{item.title}</button>
              </li>)}</ul> : <p>No matching pages.</p>)}
            </div>
          </details>
          <div className="actions">
            <button type="button" disabled={!destination.trim()} onClick={addRule}>Add mapping</button>
            <button className="primary" type="button" disabled={!rules.length && !destination.trim()} onClick={() => void preview()}>Preview repairs</button>
          </div>
        </fieldset>
        {!!rules.length && <ul className="audit-findings" aria-label="Queued replacements">{rules.map(rule => <li key={rule.kind + rule.from}>
          <p className="audit-target">{rule.from} → {rule.to}</p>
          <button className="text-button" type="button" disabled={busy} onClick={() => {
            setRules(rules.filter(item => item !== rule)); setPlan(undefined);
          }}>Remove mapping</button>
        </li>)}</ul>}
      </>}
      {busy && <p role="status">Working on the requested pages…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {plan && <div className="stack repair-preview">
        <h3>Repair preview</h3>
        <p>{plan.pages.length} pages can be updated. Choose which pages to save.</p>
        {plan.pages.map(page => <div key={page.pageId} className="stack">
          <label className="checkbox"><input type="checkbox" checked={selected.includes(page.pageId)} disabled={busy} onChange={event =>
            setSelected(event.target.checked ? [...selected, page.pageId] : selected.filter(id => id !== page.pageId))} />
            {page.title} · version {page.version}</label>
          <ul className="repair-diff">{page.changes.map(change => <li key={change.kind + change.from}>
            <span>{change.occurrences} {change.occurrences === 1 ? 'occurrence' : 'occurrences'}</span>
            <del>{change.from}</del><ins>{change.to}</ins>
          </li>)}</ul>
        </div>)}
        {!!plan.skipped.length && <details><summary>Skipped in preview ({plan.skipped.length})</summary>
          <ul>{plan.skipped.map(page => <li key={page.pageId}>Page {page.pageId} · {page.reason}</li>)}</ul></details>}
        <button type="button" className="primary" disabled={busy || !selected.length} onClick={() => void apply()}>
          Apply to {selected.length} selected {selected.length === 1 ? 'page' : 'pages'}
        </button>
      </div>}
      {results && <section className="stack" aria-label="Repair results">
        <h3>{updatedCount} {updatedCount === 1 ? 'page' : 'pages'} updated</h3>
        <ul>{results.results.map(item => <li key={item.pageId}>Page {item.pageId} · {item.message}</li>)}</ul>
      </section>}
    </div>
  </details>;
}

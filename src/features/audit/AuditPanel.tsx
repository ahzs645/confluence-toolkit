import { useEffect, useState, type FormEvent } from 'react';
import { auditSchema, type AuditDefinition, type AuditOptions, type AuditReport } from '../../models/audit';
import { auditActivityKey } from '../../models/auditActivity';
import type { Binding } from '../../models/messages';
import { request, runTool } from '../../services/ExtensionCommunicationService';
import type { Collection, Space } from '../workspace/types';
import { pageIdFromUrl } from '../../services/sites';
import { PageSelection } from './PageSelection';
import { AuditResults } from './AuditResults';

const defaults = auditSchema.parse({});
const optional = (value: string) => value.trim() || undefined;

export function AuditPanel({ binding, visible, tabUrl }: { binding: Binding; visible: boolean; tabUrl?: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [definition, setDefinition] = useState<AuditDefinition>(defaults);
  const [editor, setEditor] = useState<'form' | 'json'>('form');
  const [json, setJson] = useState('');
  const [spaceList, setSpaceList] = useState<Collection<Space>>();
  const [spaceMessage, setSpaceMessage] = useState('');
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<AuditReport>();
  const docId = binding.documentId;
  const currentPage = pageIdFromUrl(tabUrl, binding.site);
  const scope = definition.scope ?? {};
  const find = definition.find ?? {};
  const check = definition.checks ?? {};

  useEffect(() => {
    const key = auditActivityKey(docId);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[key]) setProgress(String(changes[key].newValue ?? ''));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [docId]);

  function selectEditor(value: typeof editor) {
    if (value === 'json' && editor !== 'json') setJson(JSON.stringify(selected.length ? { ...definition, scope: { pageIds: selected } } : definition, null, 2));
    setError('');
    setEditor(value);
  }

  function readDefinition(): AuditOptions {
    const raw = editor === 'json' ? JSON.parse(json) : {
      ...definition,
      ...(selected.length ? { scope: { pageIds: selected } } : {}),
      find: { ...find, ignoreDomains: find.ignoreDomains?.map(domain => domain.trim()).filter(Boolean) },
      checks: { ...check, externalDomains: check.externalDomains?.map(domain => domain.trim()).filter(Boolean) },
    };
    return auditSchema.parse(raw);
  }

  async function audit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setReport(undefined);
    setProgress('Preparing audit…');
    try {
      const options = readDefinition();
      if (options.checks.enabled && options.checks.externalDomains.length) {
        const allowed = await chrome.permissions.request({
          origins: options.checks.externalDomains.map(domain => 'https://' + domain + '/*'),
        });
        if (!allowed) throw new Error('Chrome did not grant access to the selected domains. Remove them to run an internal audit.');
      }
      setReport(await request<AuditReport>({ type: 'audit', documentId: docId, definition: options }));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The audit failed.');
    } finally { setBusy(false); }
  }

  async function loadSpaces() {
    setSpaceMessage('Loading spaces…');
    try {
      const next = await runTool<Collection<Space>>('list_spaces', { limit: 50, cursor: spaceList?.nextCursor, start: spaceList?.nextStart });
      setSpaceList({ ...next, results: [...spaceList?.results ?? [], ...next.results] });
      setSpaceMessage('');
    } catch (error) { setSpaceMessage(error instanceof Error ? error.message : 'Could not load spaces.'); }
  }

  function updateScope(next: AuditDefinition['scope']) { setSelected([]); setDefinition({ ...definition, scope: next }); }
  function updateFind(next: AuditDefinition['find']) { setDefinition({ ...definition, find: next }); }
  function updateCheck(next: AuditDefinition['checks']) { setDefinition({ ...definition, checks: next }); }

  if (!visible && !report) return null;

  return <div className="audit-layout" hidden={!visible}>
    <section className="card audit-card" aria-label="Search and audit definition">
      <div className="section-header"><div><h2>Search &amp; Audit</h2>
        <p>Find hyperlinks, images, and Confluence attachments across a page, branch, or space.</p></div></div>
      <nav className="script-tabs" aria-label="Audit definition mode">
        <button type="button" aria-pressed={editor === 'form'} disabled={busy} onClick={() => selectEditor('form')}>Filters</button>
        <button type="button" aria-pressed={editor === 'json'} disabled={busy} onClick={() => selectEditor('json')}>JSON</button>
      </nav>
      <form className="stack" onSubmit={audit}>
        <fieldset className="stack script-fields" disabled={busy}>
        {editor === 'json' ? <>
          <label>Audit JSON<textarea rows={14} className="code-input" value={json} spellCheck={false}
            onChange={event => setJson(event.target.value)} required /></label>
          <div className="actions">
            <button type="button" onClick={() => {
              try { setDefinition(readDefinition()); setSelected([]); setEditor('form'); setError(''); }
              catch (error) { setError(error instanceof Error ? error.message : String(error)); }
            }}>Load filters</button>
            <button type="button" onClick={() => void navigator.clipboard.writeText(json).catch(error => setError(error.message))}>Copy JSON</button>
          </div>
        </> : <>
          <label>Page scope
            <select value={scope.pageId !== undefined ? 'page' : 'filters'} onChange={event =>
              updateScope(event.target.value === 'page' ? { pageId: '' } : {})}>
              <option value="filters">Spaces and page branches</option>
              <option value="page">One page</option>
            </select>
          </label>
          {currentPage && <button type="button" onClick={() => updateScope({ pageId: currentPage })}>Use current page · {currentPage}</button>}
          {scope.pageIds && <p>JSON selects {scope.pageIds.length} specific pages. Change the page scope to clear this selection.</p>}
          {scope.pageId !== undefined
            ? <label>Page ID<input value={scope.pageId} pattern="[0-9]+" required inputMode="numeric"
                onChange={event => updateScope({ pageId: event.target.value })} /></label>
            : <>
              <div className="form-grid">
                <label>Space key<input value={scope.space ?? ''} list="audit-spaces" placeholder="Any accessible space"
                  onChange={event => {
                    const key = optional(event.target.value);
                    const id = spaceList?.results.find(space => space.key === key)?.id;
                    updateScope({ ...scope, space: key, spaceId: id === undefined ? undefined : String(id), pageIds: undefined });
                  }} /></label>
                <label>Branch page ID<input value={scope.ancestorId ?? ''} placeholder="Optional" inputMode="numeric" pattern="[0-9]+"
                  onChange={event => updateScope({ ...scope, ancestorId: optional(event.target.value) })} /></label>
              </div>
              <datalist id="audit-spaces">{spaceList?.results.map(space => <option key={space.key} value={space.key}>{space.name}</option>)}</datalist>
              <div className="actions">
                {(!spaceList || spaceList.nextCursor || spaceList.nextStart !== undefined) && <button type="button" onClick={() => void loadSpaces()}>
                  {spaceList ? 'Load more spaces' : 'Load spaces'}
                </button>}
                {spaceMessage && <p role="status">{spaceMessage}</p>}
              </div>
            </>}
          {scope.pageId === undefined && !scope.pageIds && <>
            <PageSelection key={JSON.stringify(scope)} binding={binding} tabUrl={tabUrl} scope={scope} selected={selected} onSelect={setSelected} />
            {!selected.length && <label className="checkbox"><input type="checkbox" checked={definition.allPages ?? false}
              onChange={event => setDefinition({ ...definition, allPages: event.target.checked })} /> Audit all matching pages</label>}
          </>}
          <div className="form-grid">
            <label>Reference type<select value={find.type ?? 'all'} onChange={event =>
              updateFind({ ...find, type: event.target.value as NonNullable<AuditDefinition['find']>['type'] })}>
              <option value="all">Links and images</option><option value="links">Links</option><option value="images">Images</option>
            </select></label>
            <label>Location<select value={find.location ?? 'all'} onChange={event =>
              updateFind({ ...find, location: event.target.value as NonNullable<AuditDefinition['find']>['location'] })}>
              <option value="all">Internal and external</option><option value="internal">Internal</option><option value="external">External</option>
            </select></label>
            <label>Website domain<input value={find.domain ?? ''} placeholder="docs.example.com"
              onChange={event => updateFind({ ...find, domain: optional(event.target.value) })} /></label>
            <label>Section heading<input value={find.heading ?? ''} placeholder="Optional"
              onChange={event => updateFind({ ...find, heading: optional(event.target.value) })} /></label>
          </div>
          <label>Link text or URL contains<input value={find.text ?? ''} placeholder="Optional"
            onChange={event => updateFind({ ...find, text: optional(event.target.value) })} /></label>
          <label className="checkbox"><input type="checkbox" checked={check.enabled ?? true}
            onChange={event => updateCheck({ ...check, enabled: event.target.checked })} /> Check link and image status</label>
          <details className="audit-advanced">
            <summary>More filters</summary>
            <div className="stack details-body">
              <label className="checkbox"><input type="checkbox" checked={find.includeSubdomains ?? true}
                onChange={event => updateFind({ ...find, includeSubdomains: event.target.checked })} /> Include subdomains in search</label>
              <label>Ignore domains<input value={(find.ignoreDomains ?? []).join(',')}
                placeholder="Comma-separated domains"
                onChange={event => updateFind({ ...find, ignoreDomains: event.target.value.split(',') })} /></label>
              <label className="checkbox"><input type="checkbox" checked={check.contentQuality ?? true}
                onChange={event => updateCheck({ ...check, contentQuality: event.target.checked })} /> Check alt text, link labels, and duplicate anchors</label>
              {scope.pageId === undefined && <>
                <label>Page label<input value={scope.label ?? ''} onChange={event => updateScope({ ...scope, label: optional(event.target.value) })} /></label>
                <label>CQL filter<input value={scope.cql ?? ''} placeholder={'title ~ "handbook"'}
                  onChange={event => updateScope({ ...scope, cql: optional(event.target.value) })} /></label>
                {!definition.allPages && <label>Maximum pages<input type="number" min={1} max={1000} required value={definition.pageLimit ?? 20}
                  onChange={event => setDefinition({ ...definition, pageLimit: Number(event.target.value) })} /></label>}
              </>}
              {(check.enabled ?? true) && <>
                <label>Maximum distinct targets to check<input type="number" min={1} max={2000} required value={check.targetLimit ?? 80}
                  onChange={event => updateCheck({ ...check, targetLimit: Number(event.target.value) })} /></label>
                <label>External domains to check<input value={(check.externalDomains ?? []).join(',')}
                  onChange={event => updateCheck({ ...check, externalDomains: event.target.value.split(',') })} /></label>
                <p>Enter up to five exact HTTPS domains separated by commas. Chrome asks for access. Requests omit account credentials.</p>
              </>}
            </div>
          </details>
        </>}
          <button type="submit" className="primary">{check.enabled !== false || editor === 'json' ? 'Run audit' : 'Find references'}</button>
        </fieldset>
      </form>
      {busy && <div className="actions">
        <p role="status">{progress || 'Running audit…'}</p>
        <button type="button" onClick={() => void request({ type: 'audit:cancel', documentId: docId }).catch(error => setError(error.message))}>Cancel audit</button>
      </div>}
      {error && <pre className="markup error" role="alert">{error}</pre>}
    </section>
    {report && <AuditResults report={report} binding={binding} tabUrl={tabUrl} />}
  </div>;
}

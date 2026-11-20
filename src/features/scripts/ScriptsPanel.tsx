import { useEffect, useState, type FormEvent } from 'react';
import type { Binding } from '../../models/messages';
import { request } from '../../services/ExtensionCommunicationService';
import { scriptSchema, type LogEntry, type ReplacementPlan, type Script } from '../../services/ScriptService';
import { activityKey } from '../../models/scriptActivity';
import type { Page, SearchItem, Collection } from '../workspace/types';

const commands = ['Query', 'Select', 'Change', 'Replace'] as const;
type Command = typeof commands[number];

export function ScriptsPanel({ binding }: { binding: Binding }) {
  const [command, setCommand] = useState<Command>('Query');
  const [queryMode, setQueryMode] = useState<'keyword' | 'cql'>('keyword');
  const [query, setQuery] = useState('');
  const [pageId, setPageId] = useState('');
  const [expectedVersion, setExpectedVersion] = useState('');
  const [title, setTitle] = useState('');
  const [storage, setStorage] = useState('');
  const [changeStorage, setChangeStorage] = useState(false);
  const [target, setTarget] = useState<'page' | 'cql'>('page');
  const [field, setField] = useState<'storage' | 'title'>('storage');
  const [find, setFind] = useState('');
  const [replacement, setReplacement] = useState('');
  const [limit, setLimit] = useState('20');
  const [plan, setPlan] = useState<ReplacementPlan>();
  const [results, setResults] = useState<Collection<SearchItem>>();
  const [lastQuery, setLastQuery] = useState<Extract<Script, { command: 'query' }>>();
  const [output, setOutput] = useState<unknown>();
  const [scriptJson, setScriptJson] = useState(JSON.stringify({ command: 'query', cql: 'type = page', limit: 10 }, null, 2));
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const documentId = binding.documentId;

  useEffect(() => {
    const key = activityKey(documentId);
    let active = true;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[key]) setLogs((changes[key].newValue as LogEntry[] | undefined) ?? []);
    };
    chrome.storage.onChanged.addListener(changed);
    void chrome.storage.session.get(key).then(result => {
      if (active) setLogs((result[key] as LogEntry[] | undefined) ?? []);
    }).catch(() => {});
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); };
  }, [documentId]);

  async function run(script: Script) {
    setBusy(true);
    setError('');
    setOutput(undefined);
    if (script.command !== 'apply') setPlan(undefined);
    if (script.command === 'query') setResults(undefined);
    try {
      const result = await request({ type: 'script', documentId, script });
      if (script.command === 'replace') setPlan(result as ReplacementPlan);
      else if (script.command === 'query') {
        setResults(result as Collection<SearchItem>);
        setLastQuery(script);
      } else {
        setOutput(result);
        if (script.command === 'select') {
          const page = result as Page;
          setPageId(String(page.id));
          setExpectedVersion(String(page.version.number));
          setTitle(page.title);
          setStorage(page.body?.storage?.value ?? '');
          setChangeStorage(false);
        }
        if (script.command === 'change') setExpectedVersion(String((result as Page).version.number));
        if (script.command === 'apply') setPlan(undefined);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The script could not run.');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    switch (command) {
      case 'Query':
        return void run({ command: 'query', limit: Number(limit), ...(queryMode === 'cql' ? { cql: query } : { text: query }) });
      case 'Select':
        return void run({ command: 'select', pageId });
      case 'Change':
        return void run({ command: 'change', pageId, expectedVersion: Number(expectedVersion),
          title: title.trim() || undefined, storage: changeStorage ? storage : undefined });
      case 'Replace':
        return void run({ command: 'replace', limit: Number(limit), field, find, with: replacement,
          ...(target === 'page' ? { pageId } : { cql: query }) });
    }
  }

  function switchCommand(next: Command) {
    setCommand(next);
    setOutput(undefined);
    setError('');
    setPlan(undefined);
    if (next === 'Replace') setQuery('');
  }

  const cql = command === 'Replace' && target === 'cql';
  const queryControl = command === 'Query' || cql;
  const pageControl = command !== 'Query' && !cql;
  const next = results?.nextCursor || results?.nextStart !== undefined;

  return <section className="card scripts-card" aria-label="Scripts">
    <h2>Scripts</h2>
    <nav className="script-tabs" aria-label="Script command">
      {commands.map(name => <button key={name} type="button" aria-pressed={name === command}
        disabled={busy} onClick={() => switchCommand(name)}>{name}</button>)}
    </nav>
    <form className="stack" onSubmit={submit}>
      <fieldset className="stack script-fields" disabled={busy}>
        {command === 'Query' && <label>Query type<select value={queryMode} onChange={event => setQueryMode(event.target.value as typeof queryMode)}>
          <option value="keyword">Keyword</option><option value="cql">CQL</option>
        </select></label>}
        {command === 'Replace' && <>
          <label>Replace scope<select value={target} onChange={event => { setTarget(event.target.value as typeof target); setPlan(undefined); }}>
            <option value="page">One page</option><option value="cql">Pages matching CQL</option>
          </select></label>
          <label>Replace in<select value={field} onChange={event => { setField(event.target.value as typeof field); setPlan(undefined); }}>
            <option value="storage">Storage markup</option><option value="title">Page title</option>
          </select></label>
        </>}
        {queryControl && <label>{cql || queryMode === 'cql' ? 'CQL query' : 'Keyword'}
          <input value={query} onChange={event => { setQuery(event.target.value); setPlan(undefined); }} required />
        </label>}
        {queryControl && <label>Result limit<input type="number" min={1} max={100} required value={limit}
          onChange={event => { setLimit(event.target.value); setPlan(undefined); }} /></label>}
        {pageControl && <label>Page ID<input required inputMode="numeric" pattern="[0-9]+" value={pageId}
          onChange={event => { setPageId(event.target.value); setPlan(undefined); }} /></label>}
        {command === 'Change' && <>
          <label>Expected version<input type="number" min={1} required value={expectedVersion}
            onChange={event => setExpectedVersion(event.target.value)} /></label>
          <label>Page title<input value={title} maxLength={255} onChange={event => setTitle(event.target.value)} /></label>
          <label className="checkbox"><input type="checkbox" checked={changeStorage}
            onChange={event => setChangeStorage(event.target.checked)} /> Change storage markup</label>
          {changeStorage && <label>Storage markup<textarea className="code-input" value={storage} rows={6}
            onChange={event => setStorage(event.target.value)} /></label>}
        </>}
        {command === 'Replace' && <>
          <label>Find exact text<textarea rows={2} value={find} required
            onChange={event => { setFind(event.target.value); setPlan(undefined); }} /></label>
          <label>Replace with<textarea rows={2} value={replacement} placeholder="Leave empty to remove matches"
            onChange={event => { setReplacement(event.target.value); setPlan(undefined); }} /></label>
        </>}
        <button type="submit" className="primary">{command === 'Replace' ? 'Preview replacement' : `Run ${command.toLowerCase()}`}</button>
      </fieldset>
    </form>
    <details className="audit-advanced">
      <summary>Run script from JSON</summary>
      <div className="stack details-body">
        <label>Script JSON<textarea className="code-input" rows={7} spellCheck={false} value={scriptJson}
          disabled={busy} onChange={event => setScriptJson(event.target.value)} /></label>
        <button type="button" disabled={busy} onClick={() => {
          try {
            const script = scriptSchema.parse(JSON.parse(scriptJson));
            const names = { query: 'Query', select: 'Select', change: 'Change', replace: 'Replace', apply: 'Replace' } as const;
            setCommand(names[script.command]);
            void run(script);
          } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        }}>Run JSON script</button>
      </div>
    </details>
    {busy && <p role="status">Script running…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {command === 'Query' && results && <div className="script-output">
      <h3>Results ({results.results.length})</h3>
      <ul className="results">{results.results.map((item, index) => <li key={index}>
        {item.content?.type === 'page' && item.content.id
          ? <button type="button" className="link-button" onClick={() => {
            switchCommand('Select'); void run({ command: 'select', pageId: String(item.content!.id) });
          }}>{item.title}</button> : item.title}
      </li>)}</ul>
      {next && lastQuery && <button type="button" onClick={() =>
        void run({ ...lastQuery, cursor: results.nextCursor, start: results.nextStart })}>Next results</button>}
    </div>}
    {plan && <div className="script-output stack">
      <h3>Replacement preview</h3>
      <p>{plan.pages.length} pages have matches.</p>
      {plan.pages.length > 0 && <>
        <ul className="results">{plan.pages.map(page => <li key={page.pageId}>
          Page {page.pageId}, version {page.expectedVersion} · {page.matches} matches
        </li>)}</ul>
        <button type="button" className="primary" disabled={busy} onClick={() => void run({ command: 'apply', plan })}>Apply replacement</button>
      </>}
    </div>}
    {output !== undefined && <div className="script-output stack">
      <h3>Result</h3>
      {command === 'Select' && <button type="button" onClick={() => switchCommand('Change')}>Open in Change</button>}
      <pre className="markup page-markup">{JSON.stringify(output, null, 2)}</pre>
    </div>}
    <section className="script-output" aria-label="Script activity log">
      <div className="section-header">
        <h3>Activity log</h3>
        <div className="actions">
          <button type="button" className="text-button" disabled={!logs.length} onClick={() => {
            const text = logs.map(entry => `${new Date(entry.at).toISOString()} [${entry.level}] ${entry.message}`).join('\n');
            void navigator.clipboard.writeText(text).catch(error => setError(error.message));
          }}>Copy log</button>
          <button type="button" className="text-button" disabled={!logs.length || busy} onClick={() => {
            void request({ type: 'script:clear', documentId }).catch(error => setError(error.message));
          }}>Clear log</button>
        </div>
      </div>
      {logs.length ? <ol className="activity-log" role="log" aria-label="Script activity">
        {logs.map((entry, index) => <li key={index} data-level={entry.level}>
          <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString()}</time> {entry.message}
        </li>)}
      </ol> : <p>Script runs will appear here.</p>}
    </section>
  </section>;
}

import { useEffect, useState, type FormEvent } from 'react';
import type { Binding, BridgeStatus, Session, Site } from '../../models/messages';
import { request } from '../../services/ExtensionCommunicationService';

type Tab = { id: number; url: string; title?: string; active: boolean };

export function ConnectionPanel({ onConnect, product = 'confluence' }: { onConnect: () => void; product?: 'jira' | 'confluence' }) {
  const productName = product === 'jira' ? 'Jira' : 'Confluence';
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabId, setTabId] = useState<number>();
  const [deployment, setDeployment] = useState<Site['deployment']>('cloud');
  const [context, setContext] = useState(product === 'confluence' ? '/wiki' : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function loadTabs() {
    void request<Tab[]>({ type: 'tabs' }).then(open => {
      const ranked = open.sort((left, right) => priority(right, product) - priority(left, product));
      setTabs(ranked);
      setTabId(current => open.some(tab => tab.id === current) ? current : ranked[0]?.id);
    }, error => setError(error.message));
  }
  useEffect(loadTabs, []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    const tab = tabs.find(tab => tab.id === tabId);
    if (!tab) return;
    setBusy(true);
    setError('');
    try {
      const granted = await chrome.permissions.request({ origins: [new URL(tab.url).origin + '/*'] });
      if (!granted) throw new Error('Chrome site access is required to connect this tab.');
      await request<Binding>({ type: 'bind', tabId, deployment, context, product });
      onConnect();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="card connect-card">
    <div className="section-header">
      <div><h2>Connect to {productName}</h2><p>Choose an open Chrome tab where you’re signed in.</p></div>
      <button type="button" className="text-button" onClick={loadTabs}>Refresh tabs</button>
    </div>
    <form onSubmit={connect} className="stack">
      <label>{productName} tab
        <select value={tabId ?? ''} onChange={event => setTabId(Number(event.target.value))} disabled={busy}>
          {!tabs.length && <option value="">No HTTPS tabs found</option>}
          {tabs.map(tab => <option key={tab.id} value={tab.id}>
            {new URL(tab.url).hostname} · {tab.title || new URL(tab.url).pathname}
          </option>)}
        </select>
      </label>
      <div className="form-grid">
        <label>Deployment
          <select value={deployment} onChange={event => {
            const value = event.target.value as Site['deployment'];
            setDeployment(value);
            setContext(product === 'jira' ? value === 'cloud' ? '' : '/jira' : value === 'cloud' ? '/wiki' : '/confluence');
          }} disabled={busy}>
            <option value="cloud">{productName} Cloud</option>
            <option value="data-center">Data Center</option>
          </select>
        </label>
        <label>Context path<input value={context} onChange={event => setContext(event.target.value)} disabled={busy} /></label>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary connect-button" disabled={tabId === undefined || busy}>
        {busy ? 'Connecting…' : 'Connect tab'}
      </button>
    </form>
  </section>;
}

function priority(tab: Tab, product: 'jira' | 'confluence') {
  const url = new URL(tab.url);
  if (product === 'jira') {
    return Number(tab.active) + 4 * Number(/^\/(?:jira|browse|secure|issues|plugins)(?:\/|$)/.test(url.pathname));
  }
  return Number(tab.active) + 4 * Number(url.hostname.endsWith('.atlassian.net') && url.pathname.startsWith('/wiki'))
    + 2 * Number(url.pathname.startsWith('/confluence'));
}

export function AssistantBridge({ session, refresh }: { session: Session; refresh: () => void }) {
  const [access, setAccess] = useState<NonNullable<BridgeStatus['access']>>('read');
  const labels = { read: 'Read only', edit: 'Edit existing', write: 'Create and edit', full: 'Full access' };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connecting = session.bridge.state === 'connecting';
  const on = session.bridge.state === 'on';

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      await request({ type: on ? 'bridge:stop' : 'bridge:start', access });
      refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return <details className="card assistant-card">
    <summary>
      <span>Local assistant</span>
      <span className={on ? 'status connected' : 'status'}>{on ? labels[session.bridge.access ?? 'read'] : connecting ? 'Starting…' : 'Off'}</span>
    </summary>
    <div className="stack details-body">
      <p>Connect an MCP client through the installed native host. The bridge uses the connected tabs and the access level you select.</p>
      {!on && <label>Assistant access
        <select value={access} disabled={connecting} onChange={event => setAccess(event.target.value as typeof access)}>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>}
      {(error || session.bridge.error) && <div className="error" role="alert">{error || session.bridge.error}</div>}
      <button type="button" onClick={() => void toggle()} disabled={busy || connecting}>
        {on ? 'Stop bridge' : 'Start bridge'}
      </button>
    </div>
  </details>;
}

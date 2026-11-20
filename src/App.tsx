import { useCallback, useEffect, useState } from 'react';
import type { Session } from './models/messages';
import { AssistantBridge, ConnectionPanel } from './features/connection/ConnectionPanel';
import { AuditPanel } from './features/audit/AuditPanel';
import { ScriptsPanel } from './features/scripts/ScriptsPanel';
import { ToolPanel } from './features/scripts/ToolPanel';
import { Workspace } from './features/workspace/Workspace';
import { request } from './services/ExtensionCommunicationService';

const surface = document.documentElement.dataset.surface;
const views = [
  { id: 'pages', label: 'Pages' }, { id: 'scripts', label: 'Scripts' },
  { id: 'audit', label: 'Search & Audit' },
  { id: 'tools', label: 'Confluence tools' }, { id: 'jira', label: 'Jira' },
] as const;

export default function App() {
  const [session, setSession] = useState<Session>();
  const [tabUrl, setTabUrl] = useState<string>();
  const [windowId, setWindowId] = useState<number>();
  const [error, setError] = useState('');
  const [view, setView] = useState<typeof views[number]['id']>('pages');

  const refresh = useCallback(() => {
    void request<Session>({ type: 'state' }).then(current => {
      setSession(current);
      setError('');
    }, error => setError(error.message));
  }, []);

  useEffect(() => {
    const onSessionChange = (message: { type?: string }) => {
      if (message?.type === 'session:changed') refresh();
    };
    chrome.runtime.onMessage.addListener(onSessionChange);
    refresh();
    return () => chrome.runtime.onMessage.removeListener(onSessionChange);
  }, [refresh]);

  useEffect(() => {
    if (surface === 'index') void chrome.windows.getCurrent().then(window => setWindowId(window.id));
  }, []);

  const tabId = session?.binding?.tabId;
  useEffect(() => {
    if (tabId === undefined) return;
    let current = true;
    void chrome.tabs.get(tabId).then(tab => {
      if (current) setTabUrl(tab.url);
    }, () => {
      if (current) setTabUrl(undefined);
    });
    const update = (id: number, changes: { url?: string }) => {
      if (id === tabId && changes.url) setTabUrl(changes.url);
    };
    chrome.tabs.onUpdated.addListener(update);
    return () => { current = false; chrome.tabs.onUpdated.removeListener(update); };
  }, [tabId]);

  function openWorkspace() {
    void chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html') }).catch(error => setError(error.message));
  }

  function openSidePanel() {
    if (windowId !== undefined) {
      void chrome.sidePanel.open({ windowId }).catch(error => setError(error.message));
    }
  }

  const binding = view === 'jira' ? session?.jiraBinding : session?.binding;
  const product = view === 'jira' ? 'jira' : 'confluence';

  return <main className="app">
    <header className="top">
      <div className="brand"><img src="logo48.png" alt="" /><div><h1>Confluence Toolkit</h1>
        <p>{binding ? new URL(binding.site.origin).hostname : 'Chrome workspace'}</p></div>
      </div>
      {surface !== 'workspace' && <button type="button" onClick={openWorkspace}>Open workspace ↗</button>}
      {surface === 'index' && <button type="button" className="text-button" disabled={windowId === undefined} onClick={openSidePanel}>Side panel</button>}
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    <nav className="surface-tabs" aria-label="Extension tools">
      {views.map(item => <button key={item.id} type="button" aria-pressed={view === item.id}
        onClick={() => setView(item.id)}>{item.label}</button>)}
    </nav>
    {!session ? <p role="status" className="initial">Loading Confluence Toolkit…</p>
      : <>
          {binding && <section className="connection-bar" aria-label="Connection status">
            <div><span className="status connected">Connected</span><span className="identity">{binding.identity.name}</span></div>
            <button type="button" className="text-button" onClick={() => {
              void request({ type: 'unbind', product }).then(refresh, error => setError(error.message));
            }}>Disconnect</button>
          </section>}
          {(session.binding || session.jiraBinding) && <AssistantBridge session={session} refresh={refresh} />}
          {!binding
            ? <ConnectionPanel key={product} product={product} onConnect={refresh} />
            : view === 'pages'
              ? <Workspace key={`workspace-${binding.documentId}`} binding={binding} tabUrl={tabUrl} />
              : view === 'scripts'
                ? <ScriptsPanel key={`scripts-${binding.documentId}`} binding={binding} />
                : view !== 'audit' && <ToolPanel key={product + binding.documentId} binding={binding} />}
          {session.binding && <AuditPanel key={`audit-${session.binding.documentId}`} binding={session.binding} visible={view === 'audit'} tabUrl={tabUrl} />}
        </>}
  </main>;
}

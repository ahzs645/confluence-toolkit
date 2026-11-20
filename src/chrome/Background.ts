import type { Binding, BridgeStatus, Reply, Session } from '../models/messages';
import { MAX_ATTACHMENT_BYTES, MAX_NATIVE_PAYLOAD, NATIVE_HOST, parseTool, tools, type ToolCall } from '../models/tools';
import { auditSchema } from '../models/audit';
import { auditPageBatch } from '../services/AuditPages';
import { applyRepair, previewRepair } from './LinkRepairActivity';
import { cancelAudit, startAudit } from './AuditActivity';
import { clearScriptActivity, runScript } from './ScriptActivity';
import { stageEditorFile, uploadInConfluenceDocument } from './AttachmentUpload';
import { httpsUrl, makeSite, matchesSite, siteLink } from '../services/sites';

const BINDING = 'confluence-binding';
const JIRA_BINDING = 'jira-binding';
type Product = 'confluence' | 'jira';
type Upload = Extract<ToolCall, { name: 'upload_attachment' }>;
type ToolBinding = Omit<Binding, 'identity'> & { identity?: Binding['identity'] };
type BridgeAccess = NonNullable<BridgeStatus['access']>;
const products = ['confluence', 'jira'] as const;

function keyFor(product: Product) {
  return product === 'jira' ? JIRA_BINDING : BINDING;
}

function productFor(tool: string): Product {
  return tool.startsWith('jira_') ? 'jira' : 'confluence';
}

function allows(tool: ToolCall['name'], access: BridgeAccess) {
  const definition = tools[tool];
  if (!definition.write || access === 'full') return true;
  if (definition.destructive || access === 'read') return false;
  return access === 'write' || /(?:^|_)update_|^jira_(?:assign|transition)_/.test(tool);
}
let port: chrome.runtime.Port | undefined;
let bridge: BridgeStatus = { state: 'off', allowWrites: false };
const bindingChange = { confluence: 0, jira: 0 };

async function getBinding(product: Product = 'confluence'): Promise<Binding | undefined> {
  const key = keyFor(product);
  return (await chrome.storage.session.get(key))[key] as Binding | undefined;
}

function publishSessionChange() {
  void chrome.runtime.sendMessage({ type: 'session:changed' }).catch(() => {});
}

function disconnectBridge(error?: string) {
  const previous = port;
  port = undefined;
  bridge = { state: 'off', allowWrites: false, error };
  previous?.disconnect();
  publishSessionChange();
}

async function clearBinding(product: Product = 'confluence') {
  ++bindingChange[product];
  disconnectBridge();
  await chrome.storage.session.remove(keyFor(product));
  publishSessionChange();
}

async function runOnTab(binding: ToolBinding, call: ToolCall): Promise<Reply> {
  if (call.name === 'update_page' && call.input.target) {
    const { origin, context, deployment, accountId } = call.input.target;
    if (origin !== binding.site.origin || context !== binding.site.context
        || deployment !== binding.site.deployment || accountId !== binding.identity?.id) {
      return { ok: false, error: 'The connected Confluence site or account changed. Reconnect the original account before updating.' };
    }
  }
  const tab = await chrome.tabs.get(binding.tabId).catch(() => undefined);
  if (!tab?.url || !matchesSite(tab.url, binding.site) || (tab.pendingUrl && !matchesSite(tab.pendingUrl, binding.site))) {
    return { ok: false, error: 'The selected tab changed or closed. Connect it again.' };
  }
  try {
    if (call.name === 'upload_attachment') {
      if (binding.site.deployment === 'cloud') return await stageCloudAttachment(binding, call);
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId, documentIds: [binding.documentId] },
        world: 'MAIN',
        func: uploadInConfluenceDocument,
        args: [binding.site, call.input, MAX_ATTACHMENT_BYTES],
      });
      return injection?.result ?? { ok: false, error: 'Chrome could not confirm the upload. Check the attachment list before sending it again.' };
    }
    if (call.name === 'create_page_from_template') {
      const { templateId, ...contents } = call.input;
      const template = await runOnTab(binding, parseTool('get_page_template', { templateId }));
      if (!template.ok) return template;
      const data = template.data as { body?: { storage?: { value?: unknown } } };
      const storage = data?.body?.storage?.value;
      if (typeof storage !== 'string') return { ok: false, error: 'The template did not return storage markup.' };
      return await runOnTab(binding, parseTool('create_page', { ...contents, storage }));
    }
    return await chrome.tabs.sendMessage(binding.tabId, {
      type: 'confluence:run', site: binding.site, tool: call.name, input: call.input,
    }, { documentId: binding.documentId });
  } catch {
    return { ok: false, error: 'The Confluence tab reloaded or stopped responding. Reconnect it and check the outcome before repeating a write.' };
  }
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function stageCloudAttachment(binding: ToolBinding, call: Upload): Promise<Reply> {
  const { pageId, filename, dataBase64 } = call.input;
  if (atob(dataBase64).length > MAX_ATTACHMENT_BYTES) return { ok: false, error: 'The file exceeds 512 KiB.' };
  const page = await runOnTab(binding, parseTool('get_page', { pageId }));
  if (!page.ok) return page;
  const data = page.data as { _links?: { edituiv2?: string } };
  const editLink = siteLink(data?._links?.edituiv2, binding.site);
  const editorUrl = editLink ? new URL(editLink) : undefined;
  if (!editorUrl || !editorUrl.pathname.endsWith('/pages/edit-v2/' + pageId)) {
    return { ok: false, error: 'Confluence did not provide an editor link for this page.' };
  }

  const attachmentList = parseTool('list_attachments', { pageId, filename, limit: 25 });
  const before = await runOnTab(binding, attachmentList);
  if (!before.ok) return before;
  const nameFound = (data: unknown) => (data as { results?: { title?: string }[] })?.results?.some(item => item.title === filename);
  if (nameFound(before.data)) return { ok: false, status: 409, error: 'An attachment with this name already exists.' };

  const tab = await chrome.tabs.create({ url: editorUrl.href, active: true });
  if (tab.id === undefined) return { ok: false, error: 'Chrome could not open the Confluence editor.' };
  const expectedUrl = editorUrl.origin + editorUrl.pathname;
  let staged = false;
  for (let attempt = 0; attempt < 22; attempt++) {
    if ((await getBinding())?.documentId !== binding.documentId) {
      return { ok: false, error: 'The selected Confluence connection changed during the upload.' };
    }
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (!current) return { ok: false, error: 'The Confluence editor tab closed.' };
    if (current.url && current.status === 'complete' && current.url.startsWith(expectedUrl)) {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: stageEditorFile, args: [expectedUrl, call.input],
      });
      if (injection?.result === 'staged') { staged = true; break; }
    }
    await pause(450);
  }
  if (!staged) return { ok: false, error: 'The Confluence editor opened, but its upload surface was unavailable. Use its Add image, video, or file button.' };

  for (let attempt = 0; attempt < 8; attempt++) {
    const latest = await runOnTab(binding, attachmentList);
    if (latest.ok && nameFound(latest.data)) {
      return { ok: true, data: { pageId, filename, status: 'attached', editorUrl: editorUrl.href } };
    }
    await pause(650);
  }
  return { ok: true, data: { pageId, filename, status: 'review_in_editor', editorUrl: editorUrl.href } };
}

async function bind(message: Record<string, unknown>): Promise<Reply> {
  if (!Number.isInteger(message.tabId)) throw new Error('Choose a Confluence tab first.');
  const tabId = message.tabId as number;
  const product = message.product === 'jira' ? 'jira' : 'confluence';
  await clearBinding(product);
  const attempt = bindingChange[product];
  const tab = await chrome.tabs.get(tabId);
  const site = makeSite(tab.url ?? '', message.deployment, message.context);
  if (product === 'jira') site.product = 'jira';
  if (!await chrome.permissions.contains({ origins: [site.origin + '/*'] })) {
    throw new Error('Allow this Confluence site in Chrome to connect.');
  }
  const results = await chrome.scripting.executeScript({ target: { tabId }, files: ['static/js/content.js'] });
  const documentId = results[0]?.documentId;
  if (!documentId) throw new Error('Chrome did not find the selected tab document.');
  const candidate = { tabId, site, documentId };
  const identity = await runOnTab(candidate, parseTool(product === 'jira' ? 'jira_whoami' : 'whoami', {})) as Reply<Binding['identity']>;
  if (!identity.ok) return identity;
  if (attempt !== bindingChange[product]) throw new Error('The connection changed. Try again.');
  const binding: Binding = { ...candidate, identity: identity.data };
  await chrome.storage.session.set({ [keyFor(product)]: binding });
  publishSessionChange();
  return { ok: true, data: binding };
}

async function startBridge(access: BridgeAccess) {
  const bindings = await Promise.all(products.map(getBinding));
  if (!bindings.some(Boolean)) throw new Error('Connect a signed-in Atlassian tab first.');
  const allowWrites = access !== 'read';
  disconnectBridge();
  const native = chrome.runtime.connectNative(NATIVE_HOST);
  port = native;
  bridge = { state: 'connecting', allowWrites, access };
  publishSessionChange();
  const timeout = setTimeout(() => {
    if (port === native && bridge.state === 'connecting') disconnectBridge('The native host did not respond. Run the host installer and try again.');
  }, 5000);
  native.onDisconnect.addListener(() => {
    clearTimeout(timeout);
    if (port === native) disconnectBridge(chrome.runtime.lastError?.message ?? 'The native host disconnected.');
  });
  native.onMessage.addListener((message) => {
    if (port !== native) return;
    if (message?.type === 'ready') {
      clearTimeout(timeout);
      bridge = { state: 'on', allowWrites, access };
      publishSessionChange();
      return;
    }
    if (message?.type === 'error') {
      disconnectBridge(typeof message.error === 'string' ? message.error : 'The native host could not start.');
      return;
    }
    if (bridge.state !== 'on' || message?.type !== 'call' || typeof message.id !== 'string') return;
    void (async () => {
      let result: Reply;
      try {
        const call = parseTool(message.tool, message.input);
        const binding = bindings[productFor(call.name) === 'jira' ? 1 : 0];
        if (!allows(call.name, access)) {
          result = { ok: false, error: access === 'read' ? 'Assistant access is read-only.' : 'This operation requires a higher assistant access level.' };
        } else if (!binding) {
          result = { ok: false, error: 'Connect the corresponding Atlassian tab and restart the assistant bridge.' };
        } else {
          result = await runOnTab(binding, call);
        }
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : 'Invalid tool request.' };
      }
      if (port !== native) return;
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_NATIVE_PAYLOAD) {
        result = { ok: false, error: 'The tool result is too large for the native bridge. Try a smaller result limit.' };
      }
      native.postMessage({ type: 'result', id: message.id, result });
    })();
  });
}

async function handle(message: Record<string, unknown>): Promise<Reply> {
  switch (message.type) {
    case 'state': {
      const [binding, jiraBinding] = await Promise.all(products.map(getBinding));
      return { ok: true, data: { binding, jiraBinding, bridge } satisfies Session };
    }
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return { ok: true, data: tabs.filter(tab => tab.id !== undefined && tab.url && httpsUrl(tab.url))
        .map(({ id, url, title, active }) => ({ id, url, title, active })) };
    }
    case 'bind':
      return bind(message);
    case 'unbind':
      await clearBinding(message.product === 'jira' ? 'jira' : 'confluence');
      return { ok: true, data: null };
    case 'bridge:start':
      await startBridge(message.access === 'edit' || message.access === 'write' || message.access === 'full'
        ? message.access : message.allowWrites === true ? 'full' : 'read');
      return { ok: true, data: bridge };
    case 'bridge:stop':
      disconnectBridge();
      return { ok: true, data: bridge };
    case 'audit:pages':
    case 'repair:preview':
    case 'repair:apply': {
      const binding = await getBinding();
      if (!binding || binding.documentId !== message.documentId) throw new Error('Connect the original Confluence tab first.');
      const call: Parameters<typeof auditPageBatch>[1] = async (tool, input) => {
        if ((await getBinding())?.documentId !== binding.documentId) throw new Error('The Confluence connection changed.');
        return runOnTab(binding, parseTool(tool, input));
      };
      if (message.type === 'audit:pages') {
        const { scope } = auditSchema.parse({ scope: message.scope });
        const cursor = typeof message.cursor === 'string' ? message.cursor : undefined;
        const start = typeof message.start === 'number' ? message.start : undefined;
        return { ok: true, data: await auditPageBatch(binding.site, call, scope, { cursor, start }) };
      }
      const data = message.type === 'repair:preview' ? await previewRepair(binding, call, message.input)
        : await applyRepair(binding, call, message.input);
      return { ok: true, data };
    }
    case 'audit': {
      const binding = await getBinding();
      if (!binding || binding.documentId !== message.documentId) throw new Error('Connect the original Confluence tab first.');
      return startAudit(binding, message.definition, runOnTab, async () => (await getBinding())?.documentId === binding.documentId);
    }
    case 'audit:cancel': {
      if (typeof message.documentId === 'string') cancelAudit(message.documentId);
      return { ok: true, data: null };
    }
    case 'script': {
      const binding = await getBinding();
      if (!binding || binding.documentId !== message.documentId) throw new Error('Connect the original Confluence tab first.');
      return runScript(binding.documentId, async (tool, input) => {
        if ((await getBinding())?.documentId !== binding.documentId) throw new Error('The Confluence connection changed.');
        const result = await runOnTab(binding, parseTool(tool, input));
        if (!result.ok) throw new Error(result.error);
        return result.data;
      }, message.script);
    }
    case 'script:clear': {
      const binding = await getBinding();
      if (!binding || binding.documentId !== message.documentId) throw new Error('Connect the original Confluence tab first.');
      await clearScriptActivity(binding.documentId);
      return { ok: true, data: null };
    }
    case 'tool': {
      const call = parseTool(message.tool, message.input);
      const binding = await getBinding(productFor(call.name));
      if (!binding || (message.documentId && binding.documentId !== message.documentId)) {
        throw new Error('Connect the corresponding Atlassian tab first.');
      }
      return runOnTab(binding, call);
    }
    default:
      return { ok: false, error: 'Unrecognized extension action.' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse: (value: Reply) => void) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !message || typeof message !== 'object') return;
  void handle(message).then(sendResponse, error => sendResponse({
    ok: false,
    error: error instanceof Error ? error.message : 'The extension could not complete the request.',
  }));
  return true;
});

function resetOnTabChange(tabId: number, url?: string) {
  for (const product of products) {
    void getBinding(product).then(binding => {
      if (binding?.tabId === tabId && (!url || !matchesSite(url, binding.site))) return clearBinding(product);
    });
  }
}

chrome.tabs.onRemoved.addListener(tabId => resetOnTabChange(tabId));
chrome.tabs.onReplaced.addListener((_added, removed) => resetOnTabChange(removed));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') resetOnTabChange(tabId);
  else if (change.url) resetOnTabChange(tabId, change.url);
});

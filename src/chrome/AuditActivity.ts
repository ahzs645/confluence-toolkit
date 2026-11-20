import { auditSchema, type LinkHealth } from '../models/audit';
import type { Binding, Reply } from '../models/messages';
import { parseTool, type ToolCall } from '../models/tools';
import { auditActivityKey } from '../models/auditActivity';
import { runAudit } from '../services/AuditService';
import { allowedInternalUrl, probeReference } from '../services/ReferenceProbe';

const active = new Map<string, AbortController>();

export function cancelAudit(documentId: string) {
  active.get(documentId)?.abort();
}

export async function startAudit(
  binding: Binding, input: unknown, runOnTab: (binding: Binding, call: ToolCall) => Promise<Reply>,
  isCurrent: () => Promise<boolean>,
): Promise<Reply> {
  const { documentId, site, tabId } = binding;
  if (active.has(documentId)) return { ok: false, error: 'An audit is already running for this tab.' };
  const controller = new AbortController();
  active.set(documentId, controller);
  const key = auditActivityKey(documentId);
  let progressWrite: Promise<unknown> = Promise.resolve();
  const progress = (message: string) => {
    progressWrite = progressWrite.catch(() => {}).then(() => chrome.storage.session.set({ [key]: message }));
  };

  async function requireConnection() {
    controller.signal.throwIfAborted();
    if (!await isCurrent()) throw new Error('The Confluence tab disconnected. Reconnect it before running the audit again.');
  }

  try {
    const options = auditSchema.parse(input);
    const permitted = new Set<string>();
    if (options.checks.enabled) {
      for (const domain of options.checks.externalDomains) {
        if (await chrome.permissions.contains({ origins: ['https://' + domain + '/*'] })) permitted.add(domain);
      }
    }
    progress('Finding pages…');
    const result = await runAudit(site, {
      call: async (tool, input) => {
        await requireConnection();
        return runOnTab(binding, parseTool(tool, input));
      },
      probe: async (url, kind, internal): Promise<LinkHealth> => {
        await requireConnection();
        if (internal && allowedInternalUrl(url, site)) {
          try {
            const reply: Reply<LinkHealth> = await chrome.tabs.sendMessage(tabId, {
              type: 'confluence:probe', site, url: url.href, kind,
            }, { documentId });
            return reply.ok ? reply.data : { status: 'error', note: reply.error };
          } catch { return { status: 'error', note: 'The Confluence tab is no longer available.' }; }
        }
        if (!internal && url.origin !== site.origin && url.protocol === 'https:' && !url.port
            && !url.username && !url.password && permitted.has(url.hostname)) {
          return probeReference(url, kind, false);
        }
        return { status: 'unchecked', note: 'Chrome access was unavailable for this domain.' };
      },
    }, options, controller.signal, progress);
    return { ok: true, data: result };
  } catch (error) {
    const message = controller.signal.aborted ? 'Audit cancelled.' : error instanceof Error ? error.message : 'The audit failed.';
    progress(message);
    return { ok: false, error: message };
  } finally {
    active.delete(documentId);
    await progressWrite.catch(() => {});
  }
}

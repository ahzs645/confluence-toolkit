import { applyRepairSchema, linkRepairSchema, type LinkRule, type RepairPlan, type RepairResults } from '../models/linkRepair';
import type { Binding, Reply } from '../models/messages';
import type { Page } from '../features/workspace/types';
import type { AuditCall } from '../services/AuditPages';
import { repairMarkup } from '../services/LinkRepair';

type StoredPlan = { plan: RepairPlan; rules: Record<string, LinkRule[]>; created: number };
const running = new Set<string>();
const keyFor = (documentId: string) => 'toolkit-link-repair-' + documentId;

export async function previewRepair(binding: Binding, call: AuditCall, input: unknown): Promise<RepairPlan> {
  const { rules } = linkRepairSchema.parse(input);
  const grouped: Record<string, LinkRule[]> = {};
  for (const rule of rules) {
    for (const pageId of new Set(rule.pageIds)) {
      (grouped[pageId] ??= []).push(rule);
    }
  }
  const targets = Object.entries(grouped);
  if (targets.length > 500) throw new Error('Review up to 500 pages in one replacement plan.');
  const plan: RepairPlan = { id: crypto.randomUUID(), pages: [], skipped: [] };

  for (const [pageId, rules] of targets) {
    try {
      const reply = await call('get_page', { pageId });
      if (!reply.ok) throw new Error(reply.error);
      const page = reply.data as Page;
      const markup = page.body?.storage?.value;
      if (typeof markup !== 'string' || !page.version?.number) throw new Error('Page storage or version was unavailable.');
      const update = repairMarkup(markup, rules.map(({ kind, from, to }) => ({ kind, from, to })));
      if (!update.changes.length) throw new Error('None of the selected URL attributes are still present.');
      if (update.storage.length > 160_000) throw new Error('This page exceeds the storage limit for an update.');
      plan.pages.push({ pageId, version: page.version.number, title: page.title, changes: update.changes });
    } catch (error) {
      plan.skipped.push({ pageId, reason: error instanceof Error ? error.message : 'Preview failed.' });
    }
  }
  const saved: StoredPlan = { plan, rules: grouped, created: Date.now() };
  await chrome.storage.session.set({ [keyFor(binding.documentId)]: saved });
  return plan;
}

export async function applyRepair(binding: Binding, call: AuditCall, input: unknown): Promise<RepairResults> {
  const { planId, pageIds } = applyRepairSchema.parse(input);
  const { documentId } = binding;
  if (running.has(documentId)) throw new Error('A repair is already running for this tab.');
  running.add(documentId);
  try {
    const key = keyFor(documentId);
    const saved = (await chrome.storage.session.get(key))[key] as StoredPlan | undefined;
    if (!saved || saved.plan.id !== planId || Date.now() - saved.created > 60 * 60 * 1000) {
      throw new Error('The preview expired or changed. Preview the repair again.');
    }
    const selection = [...new Set(pageIds)];
    const eligible = new Map(saved.plan.pages.map(item => [item.pageId, item]));
    if (selection.some(id => !eligible.has(id))) throw new Error('The selection includes a page outside the preview.');
    await chrome.storage.session.remove(key);

    const identity = await call('whoami', {});
    if (!identity.ok) throw new Error(identity.error);
    if ((identity.data as Binding['identity']).id !== binding.identity.id) throw new Error('The Confluence account changed.');

    const results: RepairResults['results'] = [];
    for (const pageId of selection) {
      const expected = eligible.get(pageId)!;
      try {
        const reply = await call('get_page', { pageId });
        if (!reply.ok) throw new Error(reply.error);
        const page = reply.data as Page;
        if (page.version?.number !== expected.version) {
          results.push({ pageId, status: 'skipped', message: 'Page version changed since preview.' });
          continue;
        }
        const markup = page.body?.storage?.value;
        if (typeof markup !== 'string') throw new Error('Page storage was unavailable.');
        const update = repairMarkup(markup, saved.rules[pageId].map(({ kind, from, to }) => ({ kind, from, to })));
        const same = update.changes.length === expected.changes.length && expected.changes.every(before =>
          update.changes.some(after => after.kind === before.kind && after.from === before.from
            && after.to === before.to && after.occurrences === before.occurrences));
        if (!same) {
          results.push({ pageId, status: 'skipped', message: 'The references changed since preview.' });
          continue;
        }
        const written: Reply = await call('update_page', {
          pageId, expectedVersion: expected.version,
          target: { ...binding.site, accountId: binding.identity.id },
          title: page.title, storage: update.storage,
        });
        if (!written.ok) {
          results.push({ pageId, status: written.status === 409 ? 'skipped' : 'failed', message: written.error });
          continue;
        }
        const changed = update.changes.reduce((sum, change) => sum + change.occurrences, 0);
        results.push({ pageId, status: 'updated', message: `Updated ${changed} URL attributes.`, version: (written.data as Page).version?.number });
      } catch (error) {
        results.push({ pageId, status: 'failed', message: error instanceof Error ? error.message : 'Update failed.' });
      }
    }
    return { results };
  } finally { running.delete(documentId); }
}

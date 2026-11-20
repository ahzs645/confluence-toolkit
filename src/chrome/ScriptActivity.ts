import type { Reply } from '../models/messages';
import { executeScriptCommand, scriptSchema, type Driver, type LogEntry } from '../services/ScriptService';

import { activityKey } from '../models/scriptActivity';

const MAX_ENTRIES = 150;
let activityWrite: Promise<unknown> = Promise.resolve();
const running = new Set<string>();

function logFor(documentId: string) {
  const key = activityKey(documentId);
  return (level: LogEntry['level'], message: string) => {
    const entry = { level, message: message.slice(0, 650), at: Date.now() };
    activityWrite = activityWrite.catch(() => {}).then(async () => {
      const existing = (await chrome.storage.session.get(key))[key] as LogEntry[] | undefined;
      await chrome.storage.session.set({ [key]: [...(existing ?? []), entry].slice(-MAX_ENTRIES) });
    });
  };
}

export async function clearScriptActivity(documentId: string) {
  await activityWrite.catch(() => {});
  await chrome.storage.session.remove(activityKey(documentId));
}

export async function runScript(documentId: string, call: Driver, input: unknown): Promise<Reply> {
  if (running.has(documentId)) return { ok: false, error: 'A script is already running for this tab.' };
  running.add(documentId);
  const log = logFor(documentId);
  try {
    return { ok: true, data: await executeScriptCommand(call, scriptSchema.parse(input), log) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The script failed.';
    log('error', message);
    return { ok: false, error: message };
  } finally {
    running.delete(documentId);
    await activityWrite.catch(() => {});
  }
}

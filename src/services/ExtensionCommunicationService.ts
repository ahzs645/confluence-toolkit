import type { Reply } from '../models/messages';
import type { ToolArgs, ToolName } from '../models/tools';

export async function request<T>(message: Record<string, unknown>): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error ?? 'Confluence Toolkit did not respond.');
  return reply.data;
}

export function runTool<T, K extends ToolName = ToolName>(tool: K, input: ToolArgs<K>): Promise<T> {
  return request<T>({ type: 'tool', tool, input });
}

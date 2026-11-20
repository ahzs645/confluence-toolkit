import type { Reply, Site } from '../models/messages';
import { parseTool } from '../models/tools';
import { allowedInternalUrl, probeReference } from '../services/ReferenceProbe';
import { ConfluenceError, runConfluenceTool } from '../services/ConfluenceService';

const scope = globalThis as typeof globalThis & { confluenceToolkitLoaded?: boolean };

if (!scope.confluenceToolkitLoaded) {
  scope.confluenceToolkitLoaded = true;
  chrome.runtime.onMessage.addListener((message, sender, reply: (result: Reply) => void) => {
    if (sender.id !== chrome.runtime.id || (message?.type !== 'confluence:run' && message?.type !== 'confluence:probe')) return;
    void (async () => {
      try {
        const site: Site = message.site;
        if (message.type === 'confluence:probe') {
          const url = new URL(message.url);
          if (location.origin !== site.origin || !allowedInternalUrl(url, site)
              || (message.kind !== 'link' && message.kind !== 'image')) {
            return reply({ ok: false, error: 'The URL is outside the selected Confluence content paths.' });
          }
          return reply({ ok: true, data: await probeReference(url, message.kind, true) });
        }
        const call = parseTool(message.tool, message.input);
        reply({ ok: true, data: await runConfluenceTool(site, call) });
      } catch (error) {
        reply({
          ok: false,
          error: error instanceof Error ? error.message : 'The Confluence request failed.',
          status: error instanceof ConfluenceError ? error.status : undefined,
        });
      }
    })();
    return true;
  });
}

import { Parser } from 'htmlparser2';
import type { LinkChange, LinkRule } from '../models/linkRepair';

export function repairMarkup(storage: string, rules: Pick<LinkRule, 'kind' | 'from' | 'to'>[]) {
  const byTarget = new Map(rules.map(rule => [rule.kind + ':' + rule.from, rule]));
  if (byTarget.size !== rules.length) throw new Error('Each original destination should have one replacement per page.');

  const edits: { start: number; end: number; value: string }[] = [];
  const counts = new Map<string, LinkChange>();
  const parents: string[] = [];
  let tag = '';
  const parser = new Parser({
    onopentagname(name) { tag = name; },
    onopentag(name, _attributes, implied) { if (!implied) parents.push(name); },
    onclosetag(name) {
      const index = parents.lastIndexOf(name);
      if (index !== -1) parents.length = index;
    },
    onattribute(name, value, quoted) {
      const kind = (tag === 'a' || tag === 'ac:link') && name === 'href' ? 'link'
        : tag === 'img' && name === 'src' ? 'image'
        : tag === 'ri:url' && name === 'ri:value' ? parents.includes('ac:image') ? 'image'
          : parents.includes('ac:link') ? 'link' : undefined
        : undefined;
      if (!kind) return;
      const key = kind + ':' + value;
      const rule = byTarget.get(key);
      if (!rule) return;
      const { startIndex, endIndex } = parser;
      const original = storage.slice(startIndex, endIndex);
      const equals = original.indexOf('=');
      if (equals === -1) return;
      const delimiter = quoted === "'" ? "'" : '"';
      const escaped = rule.to.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
      const prefix = original.slice(0, equals + 1) + original.slice(equals + 1).match(/^\s*/)?.[0];
      edits.push({ start: startIndex, end: endIndex, value: prefix + delimiter + escaped + delimiter });
      const previous = counts.get(key) ?? { ...rule, occurrences: 0 };
      previous.occurrences++;
      counts.set(key, previous);
    },
  }, { recognizeSelfClosing: true, recognizeCDATA: true });
  parser.end(storage);

  const segments: string[] = [];
  let offset = 0;
  for (const edit of edits) {
    segments.push(storage.slice(offset, edit.start), edit.value);
    offset = edit.end;
  }
  segments.push(storage.slice(offset));
  return { storage: segments.join(''), changes: [...counts.values()] };
}

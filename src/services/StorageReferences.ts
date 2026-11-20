import { DomUtils, parseDocument } from 'htmlparser2';
import { isTag, type Element } from 'domhandler';
import type { Reference, ReferenceTarget } from '../models/audit';

const MAX_REFERENCES_PER_PAGE = 1500;
const short = (value?: string) => value?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '';

export function readReferences(storage: string) {
  const document = parseDocument(storage, { lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true, recognizeCDATA: true });
  const references: Reference[] = [];
  const anchors = new Set<string>();
  const headings: string[] = [];
  const explicitAnchors = new Set<string>();
  const duplicateAnchors = new Set<string>();
  function recordAnchor(anchor: string) {
    if (explicitAnchors.has(anchor)) duplicateAnchors.add(anchor);
    explicitAnchors.add(anchor);
    anchors.add(anchor);
  }
  let limited = false;

  function add(kind: Reference['kind'], label: string, target: ReferenceTarget, missingAlt = false) {
    if (references.length >= MAX_REFERENCES_PER_PAGE) {
      limited = true;
      return;
    }
    references.push({
      kind, label: short(label), section: headings.filter(Boolean).join(' › ').slice(0, 320), target,
      missingAlt: kind === 'image' && missingAlt,
      missingLabel: kind === 'link' && !short(label) && (target.type === 'url' || target.type === 'anchor'),
    });
  }

  function value(item: Element, name: string) {
    const attr = item.attribs[name]?.trim();
    return attr && attr.length <= 2000 ? attr : undefined;
  }

  function walk(element: Element, depth = 0) {
    if (depth >= 160) { limited = true; return; }
    const { name, children } = element;
    const id = value(element, 'id') || (name === 'a' ? value(element, 'name') : undefined);
    if (id) recordAnchor(id);

    if (/^h[1-6]$/.test(name)) {
      const level = Number(name[1]);
      const heading = short(DomUtils.textContent(element));
      headings.length = level;
      headings[level - 1] = heading;
      if (heading) {
        anchors.add(heading);
        anchors.add(heading.replace(/\s+/g, '-'));
        anchors.add(heading.replace(/\s+/g, '-').toLowerCase());
        anchors.add(heading.replace(/[^\p{L}\p{N}]+/gu, ''));
      }
    }
    if (name === 'ac:structured-macro' && value(element, 'ac:name') === 'anchor') {
      const parameter = children.find(child => isTag(child) && child.name === 'ac:parameter');
      const macroAnchor = parameter && short(DomUtils.textContent(parameter));
      if (macroAnchor) recordAnchor(macroAnchor);
    }

    const href = (name === 'a' && value(element, 'href')) || (name === 'ac:link' && value(element, 'href'));
    if (href) {
      const images = DomUtils.findAll(item => item.name === 'img', children);
      const label = value(element, 'aria-label') || short(DomUtils.textContent(element))
        || images.map(image => value(image, 'alt')).filter(Boolean).join(' ') || value(element, 'title') || '';
      add('link', label, href.startsWith('#') ? { type: 'anchor', fragment: href.slice(1) } : { type: 'url', href });
    }

    const src = name === 'img' && value(element, 'src');
    if (src) add('image', value(element, 'alt') ?? '', { type: 'url', href: src }, !Object.hasOwn(element.attribs, 'alt'));
    const srcset = (name === 'img' || name === 'source') && value(element, 'srcset');
    if (srcset && !srcset.startsWith('data:')) {
      for (const item of srcset.split(',')) {
        const candidate = item.trim().split(/\s+/)[0];
        if (candidate && candidate !== src) add('image', value(element, 'alt') ?? '', { type: 'url', href: candidate });
      }
    }

    if (name === 'ac:image' || name === 'ac:link') {
      const kind = name === 'ac:image' ? 'image' : 'link';
      const text = short(value(element, 'ac:alt') || DomUtils.textContent(element));
      const missingAlt = kind === 'image' && !Object.hasOwn(element.attribs, 'ac:alt');
      const fragment = value(element, 'ac:anchor');
      const source = children.find(child => isTag(child) && ['ri:attachment', 'ri:url', 'ri:page'].includes(child.name)) as Element | undefined;
      if (source?.name === 'ri:attachment') {
        const filename = value(source, 'ri:filename');
        if (filename) {
          const page = source.children.find(item => isTag(item) && item.name === 'ri:page') as Element | undefined;
          const title = page && value(page, 'ri:content-title');
          add(kind, text, { type: 'attachment', name: filename,
            ...(title && page ? { pageTitle: title, space: value(page, 'ri:space-key') } : {}) }, missingAlt);
        }
      } else if (source?.name === 'ri:url') {
        const url = value(source, 'ri:value');
        if (url) add(kind, text, { type: 'url', href: url }, missingAlt);
      } else if (source?.name === 'ri:page') {
        const title = value(source, 'ri:content-title');
        if (title) add(kind, text, { type: 'page', title, space: value(source, 'ri:space-key'), fragment });
      } else if (fragment) {
        add(kind, text, { type: 'anchor', fragment });
      }
    }

    for (const child of children) if (isTag(child)) walk(child, depth + 1);
  }

  for (const node of document.children) if (isTag(node)) walk(node);
  return { references, anchors, duplicateAnchors, limited };
}

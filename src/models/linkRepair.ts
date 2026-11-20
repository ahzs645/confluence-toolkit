import { z } from 'zod';

const pageId = z.string().regex(/^\d{1,30}$/);
const kind = z.enum(['link', 'image']);

function validDestination(value: string) {
  if (/[\u0000-\u0020\u007f\\]/.test(value) || value.startsWith('//')) return false;
  if (!(value.startsWith('#') || value.startsWith('/') || /^https?:\/\//i.test(value))) return false;
  try {
    const url = new URL(value, 'https://confluence.invalid/');
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch { return false; }
}

export const linkRepairSchema = z.strictObject({
  rules: z.array(z.strictObject({
    kind,
    from: z.string().min(1).max(2000),
    to: z.string().trim().min(1).max(2000).refine(validDestination, 'Use an HTTP or HTTPS URL, a root-relative path, or a page fragment.'),
    pageIds: z.array(pageId).min(1).max(500),
  }).refine(rule => rule.from !== rule.to, 'The replacement URL must differ from the original.')).min(1).max(100),
});

export const applyRepairSchema = z.strictObject({
  planId: z.uuid(),
  pageIds: z.array(pageId).min(1).max(500),
});

export type LinkRepairRequest = z.output<typeof linkRepairSchema>;
export type LinkRule = LinkRepairRequest['rules'][number];
export type LinkChange = Pick<LinkRule, 'kind' | 'from' | 'to'> & { occurrences: number };
export type RepairPlan = {
  id: string;
  pages: { pageId: string; title: string; version: number; changes: LinkChange[] }[];
  skipped: { pageId: string; reason: string }[];
};
export type RepairResults = { results: { pageId: string; status: 'updated' | 'skipped' | 'failed'; message: string; version?: number }[] };

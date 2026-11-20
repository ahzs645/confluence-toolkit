import { z } from 'zod';

const pageId = z.string().regex(/^\d{1,30}$/);
export const domainSchema = z.string().trim().toLowerCase().max(253).regex(
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/,
  'Enter a domain such as docs.example.com.',
);
const externalDomain = domainSchema.refine(host =>
  !/\.(?:local|localhost|internal|test|invalid|example|lan|home|onion|arpa)$/.test(host),
'Use a public DNS domain.');

export const auditSchema = z.strictObject({
  scope: z.strictObject({
    pageId: pageId.optional(),
    pageIds: z.array(pageId).min(1).max(1000).optional(),
    spaceId: pageId.optional(),
    ancestorId: pageId.optional(),
    space: z.string().trim().regex(/^[\w~-]{1,100}$/).optional(),
    label: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,255}$/).optional(),
    cql: z.string().trim().min(1).max(2000).optional(),
  }).default({}).refine(scope => {
    const set = Object.values(scope).filter(value => value !== undefined);
    return (!(scope.pageId || scope.pageIds) || set.length === 1) && (!scope.spaceId || !!scope.space);
  }, 'Use page IDs on their own. Include a space key with a space ID.'),
  find: z.strictObject({
    type: z.enum(['all', 'links', 'images']).default('all'),
    location: z.enum(['all', 'internal', 'external']).default('all'),
    domain: domainSchema.optional(),
    includeSubdomains: z.boolean().default(true),
    ignoreDomains: z.array(domainSchema).max(30).default([]),
    text: z.string().trim().max(300).optional(),
    heading: z.string().trim().max(255).optional(),
  }).default({ type: 'all', location: 'all', includeSubdomains: true, ignoreDomains: [] }),
  checks: z.strictObject({
    enabled: z.boolean().default(true),
    contentQuality: z.boolean().default(true),
    externalDomains: z.array(externalDomain).max(5).default([]),
    targetLimit: z.number().int().min(1).max(2000).default(80),
  }).default({ enabled: true, contentQuality: true, externalDomains: [], targetLimit: 80 }),
  pageLimit: z.number().int().min(1).max(1000).default(20),
  allPages: z.boolean().default(false),
});

export type AuditDefinition = z.input<typeof auditSchema>;
export type AuditOptions = z.output<typeof auditSchema>;
export type Health = 'working' | 'broken' | 'restricted' | 'redirected' | 'error' | 'unchecked';
export type LinkHealth = { status: Health; note?: string; httpStatus?: number; targetPageId?: string };
export type ReferenceTarget = { type: 'url'; href: string } | { type: 'attachment'; name: string; pageTitle?: string; space?: string }
  | { type: 'page'; title: string; space?: string; fragment?: string } | { type: 'anchor'; fragment: string };
export type Reference = { kind: 'link' | 'image'; label: string; section: string; target: ReferenceTarget; missingAlt?: boolean; missingLabel?: boolean };
export type AuditRow = Reference & LinkHealth & { pageId: string; pageTitle: string; pageUrl?: string; domain: string; value: string };
export type AuditReport = {
  candidatePages: number;
  pages: { id: string; title: string; url: string; references: number; broken: number }[];
  connections: { sourceId: string; targetId: string; references: number; broken: number }[];
  scannedPages: number;
  references: number;
  checkedTargets: number;
  links: number;
  images: number;
  counts: Record<Health, number>;
  domains: { domain: string; count: number; broken: number }[];
  rows: AuditRow[];
  repeated: { value: string; references: number; pages: number; broken: number }[];
  quality: { missingAlt: number; missingLabels: number; duplicateAnchors: number };
  qualityFindings: { pageId: string; pageTitle: string; pageUrl: string; section?: string; value: string;
    check: 'Missing image alt attribute' | 'Missing link label' | 'Duplicate anchor' }[];
  issues: { pageId: string; message: string }[];
  limited: boolean;
};

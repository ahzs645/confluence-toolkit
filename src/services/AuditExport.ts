import type { AuditReport } from '../models/audit';

export function csvCell(value: string | number | undefined) {
  let text = String(value ?? '');
  if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function auditCsv(report: AuditReport) {
  const rows: (string | number | undefined)[][] = [[
    'Type', 'Status', 'HTTP status', 'Target', 'Domain', 'Label', 'Section',
    'Source page ID', 'Source page', 'Source URL', 'Details',
  ]];
  for (const row of report.rows) {
    rows.push([
      row.kind, row.status, row.httpStatus, row.value, row.domain, row.label, row.section,
      row.pageId, row.pageTitle, row.pageUrl, row.note,
    ]);
  }
  for (const finding of report.qualityFindings) {
    rows.push([
      'content check', 'finding', undefined, finding.value, undefined, undefined, finding.section,
      finding.pageId, finding.pageTitle, finding.pageUrl, finding.check,
    ]);
  }
  for (const issue of report.issues) rows.push(['page', 'skipped', undefined, undefined, undefined, undefined, undefined, issue.pageId, undefined, undefined, issue.message]);
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

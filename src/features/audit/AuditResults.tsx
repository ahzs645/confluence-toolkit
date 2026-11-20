import { useState } from 'react';
import type { AuditReport, Health } from '../../models/audit';

import type { Binding } from '../../models/messages';
import { auditCsv } from '../../services/AuditExport';
import { AuditGraphs, healthLabels as labels } from './AuditGraphs';
import { LinkRepairPanel } from './LinkRepairPanel';

export function AuditResults({ report, binding, tabUrl }: { report: AuditReport; binding: Binding; tabUrl?: string }) {
  const [filter, setFilter] = useState<'all' | Health>('all');
  const rows = report.rows.filter(row => filter === 'all' || row.status === filter);
  function exportReport(format: 'json' | 'csv') {
    const file = format === 'csv'
      ? new Blob(['\uFEFF', auditCsv(report)], { type: 'text/csv;charset=utf-8' })
      : new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const save = document.createElement('a');
    save.href = url;
    save.download = 'confluence-reference-audit.' + format;
    save.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="card audit-card" aria-label="Audit results">
    <div className="section-header">
      <div><h2>Results</h2><p>{report.checkedTargets} distinct targets checked</p></div>
      <div className="actions">
        <button type="button" onClick={() => exportReport('csv')}>Download CSV</button>
        <button type="button" onClick={() => exportReport('json')}>Download JSON</button>
      </div>
    </div>
    <div className="audit-stats" role="region" aria-label="Audit totals">
      <div><span>Pages scanned</span><strong>{report.scannedPages} / {report.candidatePages}</strong></div>
      <div><span>Links</span><strong>{report.links}</strong></div>
      <div><span>Images</span><strong>{report.images}</strong></div>
      <div><span>Broken</span><strong className={report.counts.broken ? 'danger' : undefined}>{report.counts.broken}</strong></div>
    </div>
    <AuditGraphs report={report} />
    <LinkRepairPanel report={report} binding={binding} tabUrl={tabUrl} />
    {report.limited && <p>The run reached a page, check, or result limit. Narrow the scope for more coverage.</p>}
    <details>
      <summary>Status and domain totals</summary>
      <ul className="audit-status-totals">{Object.entries(labels).map(([status, label]) => <li key={status}>{label} <strong>{report.counts[status as Health]}</strong></li>)}</ul>
      <div className="audit-table" role="region" aria-label="Reference counts by domain" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">Domain</th><th scope="col">References</th><th scope="col">Broken</th></tr></thead>
          <tbody>{report.domains.map(item => <tr key={item.domain}><td>{item.domain}</td><td>{item.count}</td><td>{item.broken}</td></tr>)}</tbody>
        </table>
      </div>
    </details>
    {report.issues.length > 0 && <details>
      <summary>Pages skipped ({report.issues.length})</summary>
      <ul>{report.issues.map(item => <li key={item.pageId}>Page {item.pageId} · {item.message}</li>)}</ul>
    </details>}
    {report.repeated.length > 0 && <details>
      <summary>Repeated destinations ({report.repeated.length})</summary>
      <ul className="audit-findings">{report.repeated.map((item, index) => <li key={index}>
        <strong>{item.value}</strong>
        <p>{item.references} references across {item.pages} {item.pages === 1 ? 'page' : 'pages'}{item.broken ? ` · ${item.broken} broken` : ''}</p>
      </li>)}</ul>
    </details>}
    {report.qualityFindings.length > 0 && <details>
      <summary>Content checks ({report.quality.missingAlt + report.quality.missingLabels + report.quality.duplicateAnchors})</summary>
      <ul className="audit-findings">{report.qualityFindings.map((item, index) => <li key={index}>
        <strong>{item.check}</strong>
        <p className="audit-target">{item.value}</p>
        <p><a href={item.pageUrl} target="_blank" rel="noreferrer">{item.pageTitle}</a>{item.section && <> · {item.section}</>}</p>
      </li>)}</ul>
    </details>}
    <label htmlFor="audit-status">Status filter</label>
    <select id="audit-status" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
      <option value="all">All findings</option>
      {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select>
    {rows.length ? <ul className="audit-findings" aria-label="Reference findings">
      {rows.map((row, index) => <li key={index}>
        <div className="audit-finding-top">
          <strong>{row.label || (row.kind === 'image' ? 'Image' : 'Link')}</strong>
          <span className={row.status === 'broken' ? 'status audit-broken' : 'status'}>
            {labels[row.status]}{row.httpStatus ? ` · ${row.httpStatus}` : ''}
          </span>
        </div>
        <p className="audit-target">{row.value}</p>
        <p>{row.pageUrl ? <a href={row.pageUrl} target="_blank" rel="noreferrer">{row.pageTitle}</a> : row.pageTitle}
          {row.section && <> · {row.section}</>}</p>
        {row.note && <p>{row.note}</p>}
      </li>)}
    </ul> : <p>No findings match the selected status.</p>}
  </section>;
}

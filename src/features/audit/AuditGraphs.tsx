import { useState } from 'react';
import type { AuditReport, Health } from '../../models/audit';

export const healthLabels: Record<Health, string> = {
  working: 'Working', broken: 'Broken', restricted: 'Restricted',
  redirected: 'Redirected', error: 'Check error', unchecked: 'Unchecked',
};

function Bars({ label, entries }: { label: string; entries: { name: string; count: number; broken?: number }[] }) {
  const scale = Math.max(1, ...entries.map(item => item.count));
  return <figure className="audit-chart">
    <figcaption>{label}</figcaption>
    <ul>{entries.map(item => <li key={item.name}>
      <span>{item.name}</span>
      <span className="chart-track" aria-hidden="true"><span className="chart-value" style={{ width: item.count / scale * 100 + '%' }}>
        {!!item.broken && <span className="chart-broken" style={{ width: item.broken / item.count * 100 + '%' }} />}
      </span></span>
      <strong>{item.count}{item.broken ? ` (${item.broken} broken)` : ''}</strong>
    </li>)}</ul>
  </figure>;
}

export function AuditGraphs({ report }: { report: AuditReport }) {
  const [selected, setSelected] = useState(report.pages.find(page =>
    report.connections.some(edge => edge.sourceId === page.id || edge.targetId === page.id))?.id ?? report.pages[0]?.id ?? '');
  const names = new Map(report.pages.map(page => [page.id, page]));
  const edges = report.connections.filter(edge => edge.sourceId === selected || edge.targetId === selected);
  function connections(direction: 'incoming' | 'outgoing') {
    const incoming = direction === 'incoming';
    const matches = edges.filter(edge => (incoming ? edge.targetId : edge.sourceId) === selected);
    return <section aria-label={incoming ? 'Incoming links' : 'Outgoing links'}>
      <h4>{incoming ? 'Incoming' : 'Outgoing'}</h4>
      {matches.length ? <ul className="connection-list">{matches.map(edge => {
        const id = incoming ? edge.sourceId : edge.targetId;
        return <li key={id}>
          <span aria-hidden="true">{incoming ? '↘' : '↗'}</span>
          <div><strong>{names.get(id)?.title ?? `Page ${id}`}</strong><p>{edge.references} links{edge.broken ? ` · ${edge.broken} broken` : ''}</p></div>
        </li>;
      })}</ul> : <p>No links in this report.</p>}
    </section>;
  }
  return <details open>
    <summary>Graphs</summary>
    <div className="stack details-body">
      <Bars label="Reference status" entries={Object.entries(report.counts).map(([key, count]) => ({
        name: healthLabels[key as Health], count, broken: key === 'broken' ? count : undefined,
      }))} />
      {report.domains.length > 0 && <Bars label="Top domains" entries={report.domains.slice(0, 8)
        .map(item => ({ name: item.domain, count: item.count, broken: item.broken }))} />}
      {report.pages.length > 0 && <div className="connection-graph">
        <label>Page link graph<select value={selected} onChange={event => setSelected(event.target.value)}>
          {report.pages.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}
        </select></label>
        <p>{report.connections.length} unique page connections in this scan.</p>
        <div className="graph-node"><strong>{names.get(selected)?.title}</strong></div>
        <div className="form-grid">{connections('incoming')}{connections('outgoing')}</div>
      </div>}
    </div>
  </details>;
}

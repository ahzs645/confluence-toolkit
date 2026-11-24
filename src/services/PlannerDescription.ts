import type { PlannerFile } from './PlannerTransfer';

type Card = PlannerFile['tasks'][number];
export type PlannerImportOptions = { history?: boolean; effortText?: boolean; estimates?: boolean; planText?: boolean; sourceText?: boolean; priorityText?: boolean; progressText?: boolean; scheduleText?: boolean; conversationText?: boolean };
export const plannerFieldNames = ['Readiness Assessment', 'Complexity Score', 'Ticket #'] as const;
type Section = { heading: string; lines: string[] };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function caption(key: string) {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function readable(value: unknown): string {
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('; ');
  if (value && typeof value === 'object') return Object.entries(value)
    .map(([key, v]) => field(caption(key), v)).filter(Boolean).join(', ');
  return String(value ?? '');
}

function field(label: string, value: unknown) {
  const text = readable(value);
  return text ? label + ': ' + text : '';
}

function changes(event: Record<string, unknown>, file: PlannerFile) {
  const details = object(event.details);
  const editFields = object(details.fields);
  const rendered = Object.entries(editFields).map(([key, raw]) => {
    const change = object(key === 'bucketId' && event.bucketChange ? event.bucketChange : raw);
    const label = key === 'bucketId' ? 'Bucket' : caption(key);
    if ('previous' in change || 'updated' in change) {
      const value = (v: unknown) => v === '' || v == null ? '(empty)' : readable(v) + (key === 'percentComplete' ? '%' : '');
      return label + ': ' + value(change.previous) + ' → ' + value(change.updated);
    }
    if (key === 'assignments' && Array.isArray(event.assignments)) {
      return event.assignments.map(a => {
        const entry = object(a);
        return [entry.deleted ? 'Removed assignee' : entry.created ? 'Added assignee' : 'Assignee', entry.resourceName || entry.resourceId].join(' ');
      }).join(', ');
    }
    if (key === 'labelassociations' && Array.isArray(raw)) {
      return raw.map(item => {
        const labelChange = object(item);
        const name = file.plannerRecords?.labels?.find(l => l.id === labelChange.labelId)?.text;
        return [labelChange.deleted ? 'Removed label' : labelChange.created ? 'Added label' : 'Label', name || labelChange.labelId].join(' ');
      }).join(', ');
    }
    return field(label, raw) || label + ' changed';
  });
  const other = Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'fields'));
  return [...rendered, readable(other)].filter(Boolean).join('; ');
}

export function plannerSections(file: PlannerFile, task: Card, options: PlannerImportOptions = {}, layout: 'current' | 'previous' | 'original' = 'current') {
  const sections: Section[] = [];
  function add(heading: string, ...lines: (string | null | undefined)[]) {
    const content = lines.filter((line): line is string => Boolean(line?.trim()));
    if (content.length) sections.push({ heading, lines: content });
  }
  const { title, id, plannerTaskId, parentId, notes, notesHtml, description, checklist: _checklist,
    bucket, priority, percentComplete, status, assignedTo, labels, startDateTime, dueDateTime, duration,
    actualWork, remainingWork, work, customFields, attachments, history, outlineNumber, isSummaryTask,
    isMilestone, isCritical, predecessors, goals, conversationReferences, ...other } = task;
  const hours = (v: unknown) => file.source === 'planner-browser' && (typeof v === 'number' || (typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v)))
    ? (Number(v) / 3600).toLocaleString('en-US', {maximumFractionDigits: 4}) + ' hours' : v;
  add('Notes', description, notes !== description ? notes : '', !description && !notes ? readable(notesHtml) : '');
  const showProgress = layout !== 'current' || options.progressText;
  const progress = field('Progress', percentComplete == null ? '' : percentComplete + '%');
  if (layout === 'original') {
    add('People and progress', field('Planner owners', assignedTo), field('Bucket', bucket), field('Priority', priority),
      progress, field('Status', status), field('Labels', labels));
  } else {
    add('Progress', (layout !== 'current' || options.priorityText) && priority ? field('Priority', priority) : '',
      showProgress ? progress : '', showProgress ? field('Status', status) : '');
  }
  const schedule = [field('Start', startDateTime), field('Finish', dueDateTime)];
  if (layout === 'current' && options.scheduleText) add('Schedule', ...schedule);
  if (options.effortText) {
    add(layout === 'current' ? 'Effort' : 'Schedule and effort', ...(layout === 'current' ? [] : schedule), field('Working duration', hours(duration)), field('Total effort', hours(work)),
      field('Completed effort', hours(actualWork)), field('Remaining effort', hours(remainingWork)));
  } else if (layout !== 'current') add('Schedule', ...schedule);
  add('Custom fields', ...Object.entries(object(customFields))
    .filter(([name]) => layout === 'original' || !plannerFieldNames.some(field => field === name))
    .map(([key, v]) => field(key, v)));
  add('Attachments', ...(Array.isArray(attachments) ? attachments.flatMap(a => {
    const {name, uri} = object(a);
    return uri ? [typeof name === 'string' && !name.startsWith('http') ? name : '', readable(uri)] : [readable(a)];
  }) : [readable(attachments)]));
  add('Related work', field('Predecessors', predecessors), field('Goals', goals),
    layout !== 'current' || options.conversationText ? field('Conversations', conversationReferences) : '');
  const record = object(history);
  if (options.history && Array.isArray(record.events)) {
    add('Change history (UTC)', record.state && record.state !== 'complete' ? field('Coverage', record.state) : '',
      ...record.events.map(raw => {
        const event = object(raw);
        return [event.timestamp, event.actor || event.userAadId, changes(event,file) || caption(String(event.editType || 'Change'))].map(readable).filter(Boolean).join(' · ');
      }));
  } else if (options.history) add('Change history (UTC)', readable(history));
  if (layout !== 'current' || options.sourceText || options.planText) {
    const showPlan = layout !== 'current' || (options.planText ?? options.sourceText);
    add('Planner source', showPlan ? field('Plan', file.plan.title || file.plan.id) : '', showPlan ? file.plan.url : '',
      field('Planner card ID', id), field('Planner task ID', plannerTaskId), field('Parent ID', parentId),
      field('Outline number', outlineNumber),
      field('Task flags', [isSummaryTask && 'Summary task', isMilestone && 'Milestone', isCritical && 'Critical'].filter(Boolean)),
      ...Object.entries(other).map(([key, v]) => field(caption(key), v)));
  }
  return sections;
}

export function sectionsText(sections: Section[]) {
  return sections.map(s => [s.heading, ...s.lines].join('\n')).join('\n\n');
}

export function sectionsDocument(sections: Section[]) {
  return { type: 'doc', version: 1, content: sections.flatMap(s => [
    { type: 'heading', attrs: {level: 3}, content: [{ type: 'text', text: s.heading }] },
    ...s.lines.flatMap(line => line.split(/\r?\n/).map(text => ({
      type: 'paragraph', content: text ? [{type: 'text', text,
        ...(/^https?:\/\/[^\s]+$/i.test(text) ? { marks: [{type: 'link', attrs: {href: text}}] } : {})}] : [],
    }))),
  ]) };
}

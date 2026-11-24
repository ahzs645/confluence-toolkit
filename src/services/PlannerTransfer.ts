import { z } from 'zod';
import { plannerFieldNames, plannerSections, sectionsText, type PlannerImportOptions } from './PlannerDescription';
import { csvCell } from './AuditExport';

const title = z.string().trim().min(1);
const checklistItem = z.object({ title, isChecked: z.boolean().nullish(), id: z.string().optional() }).passthrough();
const card = z.object({
  title, id: z.string().nullish(), checklist: z.array(checklistItem).nullish(),
  description: z.string().nullish(), notes: z.string().nullish(), bucket: z.string().nullish(),
  status: z.string().nullish(), percentComplete: z.number().nullish(), priority: z.string().nullish(),
  startDateTime: z.string().nullish(), dueDateTime: z.string().nullish(), labels: z.array(z.string()).nullish(),
}).passthrough();
export const plannerFile = z.object({
  serviceType: z.literal('planner').optional(), plan: z.object({ title: z.string().nullish(), id: z.string().nullish(), url: z.string().nullish() }),
  plannerRecords: z.object({
    resources: z.array(z.object({ id:z.string(), name:z.string().nullish(), userPrincipalName:z.string().nullish() }).nullable().catch(null)).nullish().catch(null),
    assignments: z.array(z.object({ taskId:z.string(), resourceId:z.string() }).nullable().catch(null)).nullish().catch(null),
    buckets:z.array(z.object({id:z.string(),name:z.string()})).optional(), labels:z.array(z.object({id:z.string(),text:z.string().nullish()}).passthrough()).optional()}).optional(),
  tasks: z.array(card).min(1), warnings: z.array(z.string()).optional(), source: z.string().nullish(),
});
export type PlannerFile = z.infer<typeof plannerFile>;
type Card = PlannerFile['tasks'][number];
export type Row = { cardId?: string; itemId?: string; templateItem?: boolean; id: number; parent?: number; title: string; description: string; status: string; priority?: string; start?: string; due?: string; labels: string[]; custom?: Record<string,string> };

const priorities: Record<string, string> = { urgent: 'Highest', important: 'High', high: 'High', medium: 'Medium', low: 'Low' };
export const labelText = (label: string) => label.trim().replace(/\s+/g, '-').slice(0, 255);

function display(value: unknown): string {
  if (Array.isArray(value)) return value.map(display).join(', ');
  return value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
}

export function legacyPlannerDescription(file: PlannerFile, task: Card) {
  const { description, notes, checklist: _checklist, ...fields } = task;
  const lines = Object.entries(fields).filter(([, value]) => value != null && display(value) !== '');
  return [description, notes === description ? '' : notes, 'Planner plan: ' + (file.plan.title || file.plan.id || 'Untitled'),
    file.plan.url, ...lines.map(([key, value]) => key + ': ' + display(value))].filter(Boolean).join('\n');
}

function status(task: Card) {
  if (task.percentComplete === 100 || task.status === 'Completed') return 'Done';
  if ((task.percentComplete ?? 0) > 0 || task.status === 'In Progress') return 'In Progress';
  return 'To Do';
}

export function jiraRows(file: PlannerFile, templateIndex?: number, options: PlannerImportOptions = {}): Row[] {
  const rows: Row[] = [];
  const template = templateIndex === undefined ? undefined : file.tasks[templateIndex];
  for (const [index, task] of file.tasks.entries()) {
    if (index === templateIndex) continue;
    const parent = rows.length + 1;
    const labels = task.labels || [];
    const sourceFields = task.customFields as Record<string, unknown> | null | undefined;
    const custom: Record<string,string> = {};
    for (const name of plannerFieldNames) {
      const value = sourceFields?.[name];
      if (typeof value === 'string' && value.trim()) custom[name] = value.trim();
    }
    rows.push({ custom, id: parent, cardId: task.id ?? undefined, title: task.title, description: sectionsText(plannerSections(file, task, options)), status: status(task),
      start: task.startDateTime?.match(/^\d{4}-\d{2}-\d{2}(?=$|T)/)?.[0],
      due: task.dueDateTime?.match(/^\d{4}-\d{2}-\d{2}(?=$|T)/)?.[0],
      priority: priorities[task.priority?.toLowerCase() || ''], labels: [...new Set(labels.map(labelText).filter(Boolean))] });
    const items = [...(task.checklist || [])];
    if (template && task.labels?.some(label => label.toLowerCase().trim() === 'implementation')) {
      const existing = new Set(items.map(item => item.title.toLowerCase()));
      for (const item of template.checklist || []) {
        if (!existing.has(item.title.toLowerCase())) {
          items.push({ id: item.id, title: item.title, isChecked: false });
          existing.add(item.title.toLowerCase());
        }
      }
    }
    for (const item of items) {
      const uncertain = item.isChecked == null;
      rows.push({ id: rows.length + 1, parent, cardId: task.id ?? undefined, itemId: item.id,
        templateItem: !(task.checklist || []).includes(item), title: item.title, status: uncertain ? '' : item.isChecked ? 'Done' : 'To Do',
        labels: uncertain ? ['planner-status-review'] : [],
        description: ['Planner card: ' + task.title, task.id, item.id,
          uncertain ? 'Completion needs review against the original Planner card.' : undefined,
          item.title.length > 255 ? item.title : undefined].filter(Boolean).join('\n') });
    }
  }
  return rows;
}

function csv(rows: (string | number | undefined)[][]) {
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function jiraCsv(rows: Row[]) {
  const count = rows.reduce((max, row) => Math.max(max, row.labels.length), 1);
  const labels = Array<string>(count).fill('Labels');
  const custom = plannerFieldNames.filter(name => rows.some(row => row.custom?.[name]));
  const headers = ['Work item ID', 'Parent', 'Work type', 'Summary', 'Description', 'Status', 'Priority', 'Start date', 'Due date', ...labels, ...custom];
  return csv([headers, ...rows.map(row => [row.id, row.parent, row.parent ? 'Sub-task' : 'Task',
    row.title.slice(0, 255), row.description, row.status, row.priority, row.start, row.due, ...labels.map((_, i) => row.labels[i]), ...custom.map(name => row.custom?.[name])])]);
}

export type Heading = { key: string; fields: { summary: string; status: { name: string } } };
export function plannerCsv(issues: Heading[], siteUrl: string) {
  return csv([['OutlineNumber', 'Title', 'Bucket', 'Description'], ...issues.map((issue, index) =>
    [index + 1, issue.fields.summary.replace(/[\r\n]+/g, ' '), issue.fields.status.name,
      siteUrl + '/browse/' + encodeURIComponent(issue.key) + ' | Jira status: ' + issue.fields.status.name])]);
}

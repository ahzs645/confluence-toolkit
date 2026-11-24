import type { PlannerFile, Row } from './PlannerTransfer';

type Editable = { name: string; schema?: {type?:string;custom?:string;items?:string;configuration?:{isMulti?:boolean}}; operations?:string[] };
export type EditFields = Record<string,Editable>;

export function nativePlannerFields(row: Row, card: PlannerFile['tasks'][number], edit: EditFields,
  current: Record<string, unknown>, useEstimates: boolean, key: string, warnings: Set<string>) {
  const fields: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row.custom || {})) {
    const matches = Object.entries(edit).filter(([id, f]) => /^customfield_\d+$/.test(id)
      && f.name === name && f.schema?.type === 'string' && f.schema.custom?.endsWith(':textfield') && (!f.operations || f.operations.includes('set')));
    if (matches.length !== 1) throw new Error(key+' needs one editable text field named '+name+'. Check the Task layout and resume.');
    const [id] = matches[0];
    if (current[id] == null || current[id] === '') {
      fields[id] = value;
      expected[id] = value;
    } else if (current[id] !== value) warnings.add(key+' already has a different '+name);
  }
  const estimates: Record<string,string> = {};
  const expectedSeconds: Record<string,number> = {};
  if (useEstimates) {
    const saved = (current.timetracking ?? {}) as Record<string,unknown>;
    for (const [name, raw] of [['originalEstimate',card.work],['remainingEstimate',card.remainingWork]] as const) {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue;
      const secondsKey = name + 'Seconds';
      const minutes = Math.round(raw / 60);
      expectedSeconds[secondsKey] = minutes * 60;
      estimates[name] = minutes + 'm';
    }
    if (Object.keys(estimates).length) {
      if (!edit.timetracking) warnings.add(key+' has no editable Time tracking field');
      else if (saved.originalEstimateSeconds != null || saved.remainingEstimateSeconds != null || Number(saved.timeSpentSeconds) > 0) {
        if (Object.entries(expectedSeconds).some(([k,v])=>saved[k]!==v)) warnings.add(key+' already has Jira time tracking data');
      } else fields.timetracking = estimates;
    }
  }
  return {fields,expected, expectedSeconds: fields.timetracking ? expectedSeconds : {}};
}

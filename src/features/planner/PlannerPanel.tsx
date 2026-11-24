import { useMemo, useRef, useState } from 'react';
import type { Binding } from '../../models/messages';
import { request } from '../../services/ExtensionCommunicationService';
import { existingIssues, importPlanner, isPlannerHeading, plannerBuckets } from '../../services/PlannerJiraImport';
import { jiraCsv, jiraRows, plannerCsv, plannerFile, type PlannerFile } from '../../services/PlannerTransfer';

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PlannerPanel({ binding }: { binding?: Binding }) {
  const [plan, setPlan] = useState<PlannerFile>();
  const [template, setTemplate] = useState('');
  const [matchOnly, setMatchOnly] = useState(false);
  const [sourceText,setSourceText] = useState(false);
  const [progressText,setProgressText] = useState(false);
  const [scheduleText,setScheduleText] = useState(false);
  const [conversationText,setConversationText] = useState(false);
  const [priorityText,setPriorityText] = useState(false);
  const [history,setHistory] = useState(false);
  const [effortText,setEffortText] = useState(false);
  const [estimates,setEstimates] = useState(false);
  const [copyBuckets, setCopyBuckets] = useState(false);
  const [fileError, setFileError] = useState('');
  const [project, setProject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const selection = useRef(0);
  const rows = useMemo(() => plan ? jiraRows(plan, template === '' ? undefined : Number(template), {history, effortText, sourceText, priorityText, progressText, scheduleText, conversationText}) : [], [plan, template, history, effortText, sourceText, priorityText, progressText, scheduleText, conversationText]);
  const parents = rows.filter(row => !row.parent).length;
  const children = rows.length - parents;

  async function load(file?: File) {
    const version = ++selection.current;
    setPlan(undefined);
    setTemplate('');
    setHistory(false);
    setSourceText(false);
    setPriorityText(false);
    setProgressText(false);
    setScheduleText(false);
    setConversationText(false);
    setEffortText(false);
    setEstimates(false);
    setFileError('');
    if (!file) return;
    try {
      const parsed = plannerFile.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error('Invalid Planner export at ' + issue.path.join('.') + '. ' + issue.message);
      }
      if (version === selection.current) {
        setPlan(parsed.data);
        setCopyBuckets(binding?.site.deployment === 'cloud' && Boolean(parsed.data.plannerRecords?.buckets?.length));
      }
    } catch (error) {
      if (version === selection.current) setFileError(error instanceof Error ? error.message : String(error));
    }
  }

  async function transfer() {
    if (!binding || !plan || busy) return;
    setBusy(true);
    setMessage('Checking Jira project and existing Planner issues…');
    try {
      setMessage(await importPlanner(binding, project, plan, template === '' ? undefined : Number(template), setMessage, copyBuckets, matchOnly, {history, effortText, estimates, sourceText, priorityText, progressText, scheduleText, conversationText}));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  async function exportHeadings() {
    if (!binding || !/^[A-Z][A-Z0-9_]*$/.test(project)) return;
    setBusy(true);
    setMessage('');
    try {
      const candidates = await existingIssues((tool,input) => request({type:'tool',tool,input,documentId:binding.documentId}),
        project,binding.site.deployment === 'cloud');
      const issues = candidates.filter(isPlannerHeading);
      if (issues.length) download(project + '-planner-headings.csv', plannerCsv(issues, binding.site.origin + binding.site.context));
      setMessage(issues.length ? `Exported ${issues.length} Jira headings.` : 'No imported Planner cards in this project.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  return <section className="card stack" aria-label="Planner conversion">
    <h2>Planner to Jira</h2>
    <p>Open your Premium plan in Chrome, choose <strong>Export plan for Jira</strong> in Microsoft Planner Exporter, then download the Jira Toolkit JSON from the plan tab.</p>
    <label>Planner export JSON<input type="file" disabled={busy} accept=".json,application/json" onChange={event => void load(event.target.files?.[0])} /></label>
    {fileError && <p role="alert" className="error">{fileError}</p>}
    {binding && <label>Jira project key<input value={project} disabled={busy} onChange={event => {
      setProject(event.target.value.trim().toUpperCase()); setMessage('');
    }} /></label>}
    {plan && <>
      <h3>{plan.plan.title || 'Planner export'}</h3>
      {plan.warnings?.map(warning => <p key={warning} role="alert">{warning}</p>)}
      {(plan.source === 'dom' || plan.tasks.some(task => ['grid', 'detailed'].includes(String(task.source)) || task.detailsAvailable === false)) &&
        <p>Screen-based export. Check the card count and checklist details against your Planner view.</p>}
      <label>Standard checklist for cards labeled Implementation<select disabled={busy} value={template} onChange={event => setTemplate(event.target.value)}>
        <option value="">Use each card’s own checklist</option>
        {plan.tasks.map((task, index) => !!task.checklist?.length && <option key={index} value={index}>{task.title}</option>)}
      </select></label>
      {template && <p>The selected template is excluded. Missing steps start open on matching cards.</p>}
      <p role="status">{parents} {parents === 1 ? 'card' : 'cards'} and {children} checklist {children === 1 ? 'subtask' : 'subtasks'}</p>
      <details><summary>Preview work items</summary><ol>{rows.map(row => <li key={row.id}>
        {row.title} · {row.status || 'Review completion'}{row.parent ? ' · child of row ' + row.parent : ''}
        {row.start && <> · Start <time dateTime={row.start}>{row.start}</time></>}
        {row.due && <> · Due <time dateTime={row.due}>{row.due}</time></>}
      </li>)}</ol></details>
      <label><input type="checkbox" checked={sourceText} disabled={busy} onChange={e => setSourceText(e.target.checked)} />
        Include Planner source details in the description (plan name, link, IDs and outline number)
      </label>
      <label><input type="checkbox" checked={priorityText} disabled={busy} onChange={e => setPriorityText(e.target.checked)} />
        Include Planner priority in the description
      </label>
      <label><input type="checkbox" checked={progressText} disabled={busy} onChange={e => setProgressText(e.target.checked)} />
        Include Planner progress and status in the description
      </label>
      <label><input type="checkbox" checked={scheduleText} disabled={busy} onChange={e => setScheduleText(e.target.checked)} />
        Include Planner start and finish in the description
      </label>
      <label><input type="checkbox" checked={conversationText} disabled={busy} onChange={e => setConversationText(e.target.checked)} />
        Include Teams conversation references in the description
      </label>
      <label><input type="checkbox" checked={history} disabled={busy} onChange={e => setHistory(e.target.checked)} />
        Include Planner change history in the description
      </label>
      <label><input type="checkbox" checked={effortText} disabled={busy} onChange={e => setEffortText(e.target.checked)} />
        Include Planner duration and effort in the description
      </label>
      {binding ? <>
        {plan.source === 'planner-browser' && <label><input type="checkbox" checked={estimates} disabled={busy} onChange={e => setEstimates(e.target.checked)} />
          Copy total and remaining effort to Jira Time tracking estimates on direct import
        </label>}
        {binding.site.deployment === 'cloud' && plannerBuckets(plan).length > 0 && <label>
          <input type="checkbox" checked={copyBuckets} disabled={busy} onChange={event => setCopyBuckets(event.target.checked)} />
          Create and match {plannerBuckets(plan).length} Planner buckets as Jira categories
        </label>}
        <label><input type="checkbox" checked={matchOnly} disabled={busy} onChange={event => setMatchOnly(event.target.checked)} />
          Match existing Jira work items only
        </label>
        <button type="button" className="primary" disabled={busy || !rows.length || !/^[A-Z][A-Z0-9_]*$/.test(project)}
          onClick={() => void transfer()}>Import directly into {project || 'Jira'}</button>
        <p>Creates tasks and subtasks in the connected project. Existing Planner imports are matched by source ID. Add a multi-person field named Planner owners to the Task layout to copy every matched owner. A sole owner also fills an empty Assignee. Shared cards leave Assignee available for the team.
          Keep this workspace open. Run again to resume an interrupted transfer.</p>
      </> : <p>Connect your signed-in Jira tab above to import directly.</p>}
      <button type="button" disabled={!rows.length} onClick={() => download('planner-jira.csv', jiraCsv(rows))}>Download Jira CSV</button>
      <p>In Jira, open Spaces → Create space → Import data → CSV. Select the destination space.
        Map Work item ID, Parent, Work type, Summary, Description, Status and Labels. Map Start date and Due date to their Jira fields using yyyy-MM-dd.
        For later matching by the direct importer, enable Planner source details before downloading the CSV. Import the CSV once per destination.</p>
    </>}
    <h2>Jira headings to Planner</h2>
    <p>Download current summaries, workflow statuses and Jira links for imported Planner cards.
      Review against existing Planner cards. Planner’s CSV import creates new cards.</p>
    {binding ? <>
      <button disabled={busy || !/^[A-Z][A-Z0-9_]*$/.test(project)} onClick={() => void exportHeadings()}>{busy ? 'Reading headings…' : 'Download Planner CSV'}</button>
    </> : <p>Connect a signed-in tab under Jira to export headings.</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

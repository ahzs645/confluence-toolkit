import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { Binding } from '../../models/messages';
import { tools, type ToolName } from '../../models/tools';
import { request } from '../../services/ExtensionCommunicationService';

export function ToolPanel({ binding }: { binding: Binding }) {
  const jira = binding.site.product === 'jira';
  const names = (Object.keys(tools) as ToolName[]).filter(name => name.startsWith('jira_') === jira);
  const [name, setName] = useState<ToolName>(jira ? 'jira_search' : 'get_space');
  const [input, setInput] = useState(jira ? '{\n  "jql": "ORDER BY updated DESC"\n}' : '{\n  "space": ""\n}');
  const [output, setOutput] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const definition = tools[name];
  const schema = z.toJSONSchema(definition.schema, { io: 'input' });
  const properties = Object.entries(schema.properties ?? {});

  async function run(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setOutput(undefined);
    try {
      const parsed: unknown = JSON.parse(input);
      const validated = definition.schema.parse(parsed);
      setOutput(await request({ type: 'tool', documentId: binding.documentId, tool: name, input: validated }));
    } catch (error) {
      if (error instanceof z.ZodError) {
        setError(error.issues.map(issue => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('\n'));
      } else {
        setError(error instanceof Error ? error.message : String(error));
      }
    } finally { setBusy(false); }
  }

  return <section className="card scripts-card" aria-label={jira ? 'Jira tools' : 'Confluence tools'}>
    <h2>{jira ? 'Jira tools' : 'Confluence tools'}</h2>
    <form className="stack" onSubmit={run}>
      <label htmlFor="tool-picker">Tool</label><select id="tool-picker" disabled={busy} value={name} onChange={event => {
        setName(event.target.value as ToolName);
        setInput('{}');
        setError('');
        setOutput(undefined);
      }}>
        {names.map(toolName => <option key={toolName} value={toolName}>{tools[toolName].label}</option>)}
      </select>
      <p>{definition.description}</p>
      {properties.length > 0 && <details>
        <summary>Input fields</summary>
        <ul>{properties.map(([key, field]) => <li key={key}>
          <code>{key}</code>{schema.required?.includes(key) ? ' (required)' : ''}{typeof field === 'object' && field.description ? ` · ${field.description}` : ''}
        </li>)}</ul>
      </details>}
      <label>Inputs as JSON<textarea className="code-input" rows={6} value={input}
        disabled={busy} onChange={event => setInput(event.target.value)} spellCheck={false} required /></label>
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Running…' : definition.destructive ? 'Run destructive action' : 'Run tool'}</button>
    </form>
    {error && <pre className="markup error" role="alert">{error}</pre>}
    {output !== undefined && <pre aria-label="Tool result" className="markup page-markup">{JSON.stringify(output, null, 2)}</pre>}
  </section>;
}

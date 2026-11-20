import { z } from 'zod';
import { tool } from './toolDefinition';

const numberId = z.string().regex(/^\d{1,30}$/);
const key = z.string().regex(/^[A-Za-z0-9_]{1,70}$/);
const issue = z.string().regex(/^(?:[A-Za-z0-9_]{1,70}-)?[0-9]{1,24}$/);
const shortText = z.string().trim().min(1).max(255);
const comment = z.string().trim().min(1).max(40_000);
const account = z.string().min(1).max(255);
const paging = { limit: z.number().int().min(1).max(100).default(25), start: z.number().int().min(0).max(1_000_000).optional() };
const project = { projectKey: key };
const issueInput = { issue };
const commentId = { ...issueInput, commentId: numberId };
const board = { boardId: numberId };
const sprint = { sprintId: numberId };
const desk = { serviceDeskId: numberId };
const jql = z.string().trim().min(1).max(3000);
const fields = z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.json())
  .refine(value => Object.keys(value).length <= 100 && JSON.stringify(value).length <= 80_000, 'Use up to 100 fields and 80,000 characters.');
const sprintDetails = {
  name: shortText,
  goal: z.string().max(1000).optional(),
  startDate: z.iso.datetime({ offset: true }).optional(),
  endDate: z.iso.datetime({ offset: true }).optional(),
};

export const jiraTools = {
  jira_whoami: tool('Check Jira session', 'Identify the signed-in Jira account.', false, {}),
  jira_search: tool('Search issues', 'Find Jira issues with JQL. Pass the nextPageToken returned by Cloud or the offset for Data Center.', false, {
    jql, ...paging, nextPageToken: z.string().max(4096).optional(),
  }),
  jira_get_issue: tool('Read issue', 'Read a Jira issue by key or numeric ID.', false, issueInput),
  jira_get_issue_fields: tool('Read issue edit fields', 'Get field and option metadata for one issue.', false, issueInput),
  jira_list_fields: tool('List Jira fields', 'List standard and custom fields.', false, {}),
  jira_issue_history: tool('Read issue history', 'Get issue changelog. Data Center returns the changelog embedded in the issue.', false, { ...issueInput, ...paging }),
  jira_create_issue: tool('Create issue', 'Create an issue using the project and issue type. Additional fields can provide project-required values.', true, {
    ...project, issueTypeId: numberId, summary: shortText, description: comment.optional(), fields: fields.optional(),
  }),
  jira_update_issue: tool('Edit issue', 'Change one or more Jira issue fields. Use Jira’s field IDs and values.', true, { ...issueInput, fields }),
  jira_delete_issue: tool('Delete issue', 'Permanently delete one issue. Subtasks are protected by Jira’s default delete behavior.', true, {
    ...issueInput, confirm: z.literal(true),
  }, true),
  jira_list_comments: tool('List issue comments', 'Read Jira issue comments.', false, { ...issueInput, ...paging }),
  jira_add_comment: tool('Add issue comment', 'Add a text comment to an issue.', true, { ...issueInput, text: comment }),
  jira_update_comment: tool('Edit issue comment', 'Replace a Jira issue comment.', true, { ...commentId, text: comment }),
  jira_delete_comment: tool('Delete issue comment', 'Permanently delete a Jira issue comment.', true, { ...commentId, confirm: z.literal(true) }, true),
  jira_list_transitions: tool('List transitions', 'Get the workflow transitions available for an issue.', false, issueInput),
  jira_transition_issue: tool('Transition issue', 'Move an issue through an available workflow transition.', true, {
    ...issueInput, transitionId: numberId, fields: fields.optional(),
  }),
  jira_assign_issue: tool('Assign issue', 'Assign an issue using the Cloud account ID or Data Center username. Use null to unassign.', true, {
    ...issueInput, assignee: account.nullable(),
  }),
  jira_list_projects: tool('List Jira projects', 'List accessible Jira projects. Cloud accepts a name or key query.', false, {
    ...paging, query: shortText.optional(),
  }),
  jira_get_project: tool('Read Jira project', 'Read a Jira project by key or ID.', false, project),
  jira_project_issue_types: tool('List issue types', 'List issue types and statuses for a project.', false, project),
  jira_project_versions: tool('List project versions', 'List release versions in a project.', false, project),
  jira_project_components: tool('List project components', 'List components in a project.', false, project),
  jira_create_version: tool('Create project version', 'Create a release version for a Jira project.', true, {
    ...project, name: shortText, description: z.string().max(1000).optional(),
  }),
  jira_update_version: tool('Edit project version', 'Update a release version name or released status.', true, {
    versionId: numberId, name: shortText.optional(), released: z.boolean().optional(),
  }),
  jira_list_worklogs: tool('List worklogs', 'Read the time logged to an issue.', false, { ...issueInput, ...paging }),
  jira_add_worklog: tool('Log time', 'Add time spent to a Jira issue.', true, {
    ...issueInput, seconds: z.number().int().min(1).max(31_536_000), started: z.string().max(40).optional(), text: comment.optional(),
  }),
  jira_get_attachment: tool('Read Jira attachment', 'Get attachment metadata and a signed-in browser download URL.', false, { attachmentId: numberId }),
  jira_list_link_types: tool('List issue link types', 'List the available Jira issue link types.', false, {}),
  jira_link_issues: tool('Link issues', 'Create a link between two issues using an existing link type.', true, {
    inward: issue, outward: issue, linkType: shortText,
  }),
  jira_unlink_issues: tool('Remove issue link', 'Delete a specific issue link.', true, { linkId: numberId, confirm: z.literal(true) }, true),
  jira_search_users: tool('Search Jira users', 'Find Jira users by display name, email, or username as allowed by the instance.', false, {
    query: shortText, ...paging,
  }),
  jira_list_watchers: tool('List issue watchers', 'Read watcher information for an issue.', false, issueInput),
  jira_add_watcher: tool('Add watcher', 'Add a Cloud account ID or Data Center username as watcher.', true, { ...issueInput, user: account }),
  jira_remove_watcher: tool('Remove watcher', 'Remove a named watcher from an issue.', true, { ...issueInput, user: account }),
  jira_list_boards: tool('List agile boards', 'List accessible Jira Software boards.', false, { ...paging, projectKey: key.optional() }),
  jira_board_issues: tool('List board issues', 'Read issues on a Jira Software board, optionally filtered by JQL.', false, { ...board, ...paging, jql: jql.optional() }),
  jira_list_sprints: tool('List board sprints', 'Read Jira Software sprints on a board.', false, { ...board, ...paging }),
  jira_sprint_issues: tool('List sprint issues', 'Read issues in a Jira Software sprint.', false, { ...sprint, ...paging }),
  jira_create_sprint: tool('Create sprint', 'Create a sprint on a Jira Software board.', true, { ...board, ...sprintDetails }),
  jira_update_sprint: tool('Edit sprint', 'Update metadata for a Jira Software sprint.', true, {
    ...sprint, ...sprintDetails, name: sprintDetails.name.optional(), state: z.enum(['future', 'active', 'closed']).optional(),
  }),
  jira_move_to_sprint: tool('Move issues to sprint', 'Move issues into a Jira Software sprint.', true, { ...sprint, issues: z.array(issue).min(1).max(50) }),
  jira_move_to_backlog: tool('Move issues to backlog', 'Move issues into the Jira Software backlog.', true, { issues: z.array(issue).min(1).max(50) }),
  jira_list_service_desks: tool('List service desks', 'List accessible Jira Service Management desks.', false, paging),
  jira_list_request_types: tool('List request types', 'Read request types offered by a service desk.', false, { ...desk, ...paging }),
  jira_list_queues: tool('List service queues', 'Read the queues you can access as a service desk agent.', false, { ...desk, ...paging }),
  jira_list_queue_issues: tool('List queue issues', 'Read issues in a service desk queue.', false, { ...desk, queueId: numberId, ...paging }),
  jira_list_requests: tool('List customer requests', 'List Jira Service Management requests visible to you.', false, { serviceDeskId: numberId.optional(), ...paging }),
  jira_get_request: tool('Read customer request', 'Read a Jira Service Management request and its status.', false, issueInput),
  jira_create_request: tool('Create customer request', 'Create a request using the service desk’s request type fields.', true, {
    ...desk, requestTypeId: numberId, fields,
  }),
  jira_list_sla: tool('Read request SLA', 'Read Jira Service Management SLA metrics for a request.', false, { ...issueInput, ...paging }),
};

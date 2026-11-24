import type { ToolCall } from '../models/tools';
import type { Request } from './ConfluenceService';

export type JiraCall = Extract<ToolCall, { name: `jira_${string}` }>;

export function isJiraCall(call: ToolCall): call is JiraCall {
  return call.name.startsWith('jira_');
}

export function buildJiraRequest(call: JiraCall, cloud: boolean): Request {
  const api = cloud ? '/rest/api/3' : '/rest/api/2';
  const input = call.input;
  const properties = 'plannerProperties' in input && input.plannerProperties ? {properties:'plannerSource'} : {};
  const sourceProperty = 'plannerSource' in input && input.plannerSource
    ? {properties:[{key:'plannerSource',value:input.plannerSource}]} : {};
  const issue = api + '/issue/' + ('issue' in input ? input.issue : '');
  const project = api + '/project/' + ('projectKey' in input ? input.projectKey : '');
  const board = '/rest/agile/1.0/board/' + ('boardId' in input ? input.boardId : '');
  const sprint = '/rest/agile/1.0/sprint/' + ('sprintId' in input ? input.sprintId : '');
  const deskApi = '/rest/servicedeskapi';
  const desk = deskApi + '/servicedesk/' + ('serviceDeskId' in input ? input.serviceDeskId : '');
  const request = deskApi + '/request/' + ('issue' in input ? input.issue : '');
  const paging = 'limit' in input ? { maxResults: input.limit, startAt: input.start } : {};
  const deskPaging = 'limit' in input ? { limit: input.limit, start: input.start } : {};

  function textBody(text: string) {
    return cloud ? { type: 'doc', version: 1, content: text.split(/\r?\n/).map(line => ({
      type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
    })) } : text;
  }

  switch (call.name) {
    case 'jira_whoami': return { path: api + '/myself' };
    case 'jira_search':
      return cloud
        ? { path: api + '/search/jql', query: { maxResults: call.input.limit, nextPageToken: call.input.nextPageToken,
            ...properties, jql: call.input.jql, fields: call.input.fields?.join(',') ?? 'summary,status,assignee,issuetype,project' } }
        : { path: api + '/search', query: { ...paging, ...properties, jql: call.input.jql, fields: call.input.fields?.join(',') ?? 'summary,status,assignee,issuetype,project' } };
    case 'jira_get_issue': return { path: issue, query:{...properties,...(call.input.identityOnly ? {fields:'key'} : {})} };
    case 'jira_get_issue_fields': return { path: issue + '/editmeta' };
    case 'jira_list_fields': return { path: api + '/field' };
    case 'jira_issue_history':
      return cloud ? { path: issue + '/changelog', query: paging } : { path: issue, query: { expand: 'changelog', fields: 'summary' } };
    case 'jira_create_issue': {
      const { fields, projectKey, issueTypeId, summary, description } = call.input;
      return { path: api + '/issue', method: 'POST', body: { ...sourceProperty, fields: {
        ...fields, project: { key: projectKey }, issuetype: { id: issueTypeId }, summary,
        ...(description === undefined ? {} : { description: textBody(description) }),
      } } };
    }
    case 'jira_update_issue': return { path: issue, method: 'PUT', body: { ...sourceProperty, fields: call.input.fields } };
    case 'jira_delete_issue': return { path: issue, method: 'DELETE' };
    case 'jira_list_comments': return { path: issue + '/comment', query: paging };
    case 'jira_add_comment':
      return { path: issue + '/comment', method: 'POST', body: { body: textBody(call.input.text) } };
    case 'jira_update_comment':
      return { path: issue + '/comment/' + call.input.commentId, method: 'PUT', body: { body: textBody(call.input.text) } };
    case 'jira_delete_comment': return { path: issue + '/comment/' + call.input.commentId, method: 'DELETE' };
    case 'jira_list_transitions': return { path: issue + '/transitions', query: { expand: 'transitions.fields' } };
    case 'jira_transition_issue':
      return { path: issue + '/transitions', method: 'POST', body: { transition: { id: call.input.transitionId }, fields: call.input.fields } };
    case 'jira_assign_issue':
      return { path: issue + '/assignee', method: 'PUT', body: cloud ? { accountId: call.input.assignee } : { name: call.input.assignee } };
    case 'jira_list_projects':
      return cloud ? { path: api + '/project/search', query: { ...paging, query: call.input.query } } : { path: api + '/project' };
    case 'jira_get_project': return { path: project };
    case 'jira_project_issue_types': return { path: project + '/statuses' };
    case 'jira_project_versions': return { path: project + '/versions' };
    case 'jira_project_components': return { path: project + '/components' };
    case 'jira_create_version':
      return { path: api + '/version', method: 'POST', body: { project: call.input.projectKey, name: call.input.name, description: call.input.description } };
    case 'jira_update_version':
      return { path: api + '/version/' + call.input.versionId, method: 'PUT', body: { name: call.input.name, released: call.input.released } };
    case 'jira_list_worklogs': return { path: issue + '/worklog', query: paging };
    case 'jira_add_worklog':
      return { path: issue + '/worklog', method: 'POST', body: {
        timeSpentSeconds: call.input.seconds, started: call.input.started, comment: call.input.text && textBody(call.input.text),
      } };
    case 'jira_get_create_fields':
      if (!cloud) throw new Error('Category import requires a Jira Cloud business space.');
      return {path: api + '/issue/createmeta/' + call.input.projectKey + '/issuetypes/' + call.input.issueTypeId, query: paging};
    case 'jira_create_category':
      if (!cloud) throw new Error('Category creation requires a Jira Cloud business space.');
      return {path: '/rest/gira/1/', query: {operation:'JwmCreateCategory'}, method:'POST', body:{
        operationName:'JwmCreateCategory', variables:{input:{...call.input,color:'TEAL'}},
        query:`mutation JwmCreateCategory($input: JWMCreateCategoryInput!) {
          createJwmCategory(input: $input) {
            success errors { message } category { option { optionId value isDisabled } }
          }
        }`,
      }};
    case 'jira_list_web_links': return { path: issue + '/remotelink' };
    case 'jira_put_web_link': return { path: issue + '/remotelink', method: 'POST', body: {
      globalId: call.input.globalId, object: { title: call.input.title, url: call.input.url },
    } };
    case 'jira_get_attachment': return { path: api + '/attachment/' + call.input.attachmentId };
    case 'jira_list_link_types': return { path: api + '/issueLinkType' };
    case 'jira_link_issues':
      return { path: api + '/issueLink', method: 'POST', body: {
        inwardIssue: { key: call.input.inward }, outwardIssue: { key: call.input.outward }, type: { name: call.input.linkType },
      } };
    case 'jira_unlink_issues': return { path: api + '/issueLink/' + call.input.linkId, method: 'DELETE' };
    case 'jira_search_users':
      return { path: api + (call.input.projectKey ? '/user/assignable/search' : '/user/search'), query: { ...paging, project:call.input.projectKey, [cloud ? 'query' : 'username']: call.input.query } };
    case 'jira_list_watchers': return { path: issue + '/watchers' };
    case 'jira_add_watcher': return { path: issue + '/watchers', method: 'POST', body: call.input.user };
    case 'jira_remove_watcher':
      return { path: issue + '/watchers', method: 'DELETE', query: { [cloud ? 'accountId' : 'username']: call.input.user } };
    case 'jira_list_boards': return { path: '/rest/agile/1.0/board', query: { ...paging, projectKeyOrId: call.input.projectKey } };
    case 'jira_board_issues':
      return { path: (cloud ? board.replace('/rest/agile/', '/rest/software/') : board) + '/issue', query: { ...paging, jql: call.input.jql } };
    case 'jira_list_sprints': return { path: board + '/sprint', query: paging };
    case 'jira_sprint_issues':
      return { path: (cloud ? sprint.replace('/rest/agile/', '/rest/software/') : sprint) + '/issue', query: paging };
    case 'jira_create_sprint': {
      const { boardId, ...details } = call.input;
      return { path: '/rest/agile/1.0/sprint', method: 'POST', body: { ...details, originBoardId: Number(boardId) } };
    }
    case 'jira_update_sprint': {
      const { sprintId: _id, ...details } = call.input;
      return { path: sprint, method: 'POST', body: details };
    }
    case 'jira_move_to_sprint': return { path: sprint + '/issue', method: 'POST', body: { issues: call.input.issues } };
    case 'jira_move_to_backlog': return { path: '/rest/agile/1.0/backlog/issue', method: 'POST', body: { issues: call.input.issues } };
    case 'jira_list_service_desks': return { path: deskApi + '/servicedesk', query: deskPaging };
    case 'jira_list_request_types': return { path: desk + '/requesttype', query: deskPaging };
    case 'jira_list_queues': return { path: desk + '/queue', query: deskPaging };
    case 'jira_list_queue_issues': return { path: desk + '/queue/' + call.input.queueId + '/issue', query: deskPaging };
    case 'jira_list_requests': return { path: deskApi + '/request', query: { ...deskPaging, serviceDeskId: call.input.serviceDeskId } };
    case 'jira_get_request': return { path: request };
    case 'jira_create_request': return { path: deskApi + '/request', method: 'POST', body: {
      serviceDeskId: call.input.serviceDeskId, requestTypeId: call.input.requestTypeId, requestFieldValues: call.input.fields,
    } };
    case 'jira_list_sla': return { path: request + '/sla', query: deskPaging };
  }
}

import { z } from 'zod';
import { jiraTools } from './jiraTools';
import { tool } from './toolDefinition';

export const NATIVE_HOST = 'com.confluence_toolkit.bridge';
export const MAX_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_NATIVE_PAYLOAD = 900 * 1024;

const id = z.string().regex(/^\d{1,30}$/).describe('Confluence numeric ID as a string');
const space = z.string().regex(/^[\w~-]{1,100}$/).describe('Cloud space ID or Data Center space key');
const title = z.string().trim().min(1).max(255);
const storage = z.string().max(160_000).describe('Confluence storage-format markup');
const pagination = {
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(4096).optional(),
  start: z.number().int().min(0).max(1_000_000).optional(),
};

export const tools = {
  whoami: tool('Check session', 'Identify the signed-in Confluence account on the connected tab.', false, {}),
  search: tool('Search pages', 'Search Confluence by text or CQL. Pass back nextCursor or nextStart with the same search to continue.', false, {
    text: z.string().trim().min(1).max(1000).optional(),
    cql: z.string().trim().min(1).max(3000).optional(),
    ...pagination,
  }),
  list_spaces: tool('List spaces', 'List spaces accessible to the signed-in account.', false, pagination),
  get_page: tool('Read page', 'Get a Confluence page, including storage markup and current version.', false, { pageId: id }),
  list_children: tool('List child pages', 'List direct child pages and other child items where supported.', false, { pageId: id, ...pagination }),
  create_page: tool('Create page', 'Create a page in a space, optionally under a parent. Use the space ID on Cloud and the space key on Data Center.', true, {
    space, parentId: id.optional(), title, storage,
  }),
  update_page: tool('Update page', 'Replace a page title and storage markup. Supply the version from the read used to prepare the edit.', true, {
    pageId: id,
    expectedVersion: z.number().int().positive().max(2_147_483_646),
    target: z.strictObject({
      origin: z.url(),
      context: z.string().max(1000),
      deployment: z.enum(['cloud', 'data-center']),
      accountId: z.string().min(1).max(255),
    }).optional().describe('Require the connection to match this site and account.'),
    title,
    storage,
  }),
  trash_page: tool('Move page to trash', 'Move a published page recoverably to trash. Confirm the intended page with the user before calling.', true, {
    pageId: id,
    confirm: z.literal(true),
  }, true),
  list_comments: tool('List comments', 'List page footer comments, including storage markup.', false, { pageId: id, ...pagination }),
  add_comment: tool('Add comment', 'Add a footer comment to a page in Confluence storage format.', true, {
    pageId: id, storage: storage.min(1),
  }),
  list_attachments: tool('List attachments', 'List page attachments with links for download in signed-in Chrome.', false, { pageId: id, ...pagination, filename: z.string().max(255).optional() }),
  upload_attachment: tool('Upload attachment', 'Upload a new attachment up to 512 KiB. On Cloud, the signed-in editor opens for review. Supply the file as base64 data.', true, {
    pageId: id,
    filename: z.string().min(1).max(255).regex(/^[^/\\\u0000-\u001f\u007f]+$/).refine(name => name !== '.' && name !== '..'),
    contentType: z.string().max(100).regex(/^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/i).optional(),
    dataBase64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  list_labels: tool('List labels', 'List the labels applied to a page.', false, { pageId: id, ...pagination }),
  add_label: tool('Add label', 'Add a global label to a page.', true, { pageId: id, name: z.string().regex(/^[a-z0-9_-]{1,255}$/) }),
  list_space_pages: tool('List pages in a space', 'List current pages directly from a space. Use the Cloud space ID or Data Center space key.', false, {
    space, ...pagination,
  }),
  get_space: tool('Read space', 'Read a space by Cloud space ID or Data Center space key.', false, { space }),
  find_page_by_title: tool('Find page by title', 'Find pages with the exact title in a specified space.', false, { space, title, ...pagination }),
  list_versions: tool('List page versions', 'Read paginated page version history.', false, { pageId: id, ...pagination }),
  get_page_version: tool('Read page version', 'Read a specific version of a page.', false, { pageId: id, version: z.number().int().positive() }),
  list_inline_comments: tool('List inline comments', 'Read Cloud inline comments on a page.', false, { pageId: id, ...pagination }),
  update_comment: tool('Edit footer comment', 'Update a comment using its current version.', true, {
    commentId: id, expectedVersion: z.number().int().positive(), storage: storage.min(1),
  }),
  delete_comment: tool('Delete footer comment', 'Permanently delete a named footer comment.', true, { commentId: id, confirm: z.literal(true) }, true),
  get_attachment: tool('Read attachment', 'Read attachment metadata and the signed-in browser download link.', false, {
    attachmentId: z.string().regex(/^(?:att)?[0-9]{1,30}$/),
  }),
  list_attachment_versions: tool('List attachment versions', 'Read Cloud attachment version history.', false, {
    attachmentId: z.string().regex(/^(?:att)?[0-9]{1,30}$/), ...pagination,
  }),
  list_page_templates: tool('List page templates', 'List built-in and site page templates on Cloud.', false, {
    spaceKey: space.optional(), ...pagination,
  }),
  get_page_template: tool('Read page template', 'Get a Cloud page template with its storage markup.', false, { templateId: id }),
  list_ancestors: tool('List page ancestors', 'Read the pages and folders above a page.', false, { pageId: id, limit: pagination.limit }),
  get_space_permissions: tool('Read space permissions', 'Read space permission assignments when permitted by Confluence.', false, {
    space, ...pagination,
  }),
  get_user: tool('Read Confluence user', 'Read a user by Cloud account ID or Data Center username.', false, {
    user: z.string().trim().min(1).max(255),
  }),
  search_users: tool('Search Confluence users', 'Search users on Cloud using user-specific CQL.', false, {
    cql: z.string().trim().min(1).max(3000), ...pagination,
  }),
  get_page_analytics: tool('Read page analytics', 'Read Cloud page view or unique viewer counts.', false, {
    pageId: id, metric: z.enum(['views', 'viewers']), fromDate: z.iso.date().optional(),
  }),
  create_page_from_template: tool('Create page from template', 'Create a Cloud page using a template’s storage markup.', true, {
    templateId: id, space, parentId: id.optional(), title,
  }),
  trash_attachment: tool('Move attachment to trash', 'Move one Cloud attachment to recoverable trash.', true, {
    attachmentId: z.string().regex(/^(?:att)?[0-9]{1,30}$/), confirm: z.literal(true),
  }, true),
  get_content_restrictions: tool('Read page restrictions', 'List the access restrictions configured for this content.', false, { pageId: id, ...pagination }),
  remove_label: tool('Remove label', 'Remove a global label from a page.', true, { pageId: id, name: z.string().regex(/^[a-z0-9_-]{1,255}$/) }),
  ...jiraTools,
};

export type ToolName = keyof typeof tools;
export type ToolArgs<K extends ToolName> = z.input<(typeof tools)[K]['schema']>;
export type ToolCall = { [K in ToolName]: { name: K; input: z.output<(typeof tools)[K]['schema']> } }[ToolName];

export function parseTool(name: unknown, input: unknown): ToolCall {
  if (typeof name !== 'string' || !Object.hasOwn(tools, name)) throw new Error('Unknown Confluence tool.');
  const key = name as ToolName;
  return { name: key, input: tools[key].schema.parse(input) } as ToolCall;
}

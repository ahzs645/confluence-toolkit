import { importPlannerOwners, plannerOwners } from '../src/services/PlannerAssignee';
import { legacyPlannerDescription, plannerFile } from '../src/services/PlannerTransfer';
import { chromium, expect, test, type Route } from '@playwright/test';
import { join, resolve } from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const build = resolve('build');
const cloud = 'https://toolkit-fixture.atlassian.net';
const dataCenter = 'https://confluence-fixture.example';
const stored = (value: string) => ({ storage: { value } });

async function openExtension(...origins: string[]) {
  // Grant only the fixture origin in a disposable copy. The production build's
  // site access prompt is exercised separately in signed-in Chrome.
  const directory = await mkdtemp(join(tmpdir(), 'confluence-extension-'));
  await cp(build, directory, { recursive: true });
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = origins.map(origin => origin + '/*');
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    const browser = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      executablePath: process.env.PW_CHROMIUM_EXECUTABLE || undefined,
      ignoreDefaultArgs: ['--disable-extensions'],
      headless: true,
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
    });
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const close = async () => {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    };
    return { browser, close, uiUrl: `chrome-extension://${extensionId}` };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const json = (route: Route, data: unknown, status = 200) => route.fulfill({ json: data, status });
const blank = (route: Route) => route.fulfill({ status: 204 });

test('Cloud workspace covers signed-in search, paging, versioned edits, and page tools', async () => {
  const { browser, close, uiUrl } = await openExtension(cloud);
  try {
    await browser.addCookies([{ url: cloud, name: 'fixture-session', value: 'signed-in', httpOnly: true, secure: true }]);
    const tab = await browser.newPage();
    let activePage = { id: '42', title: 'Test guide', spaceId: '10', version: { number: 3 }, body: stored('<p>Original</p>'),
      _links: { edituiv2: '/spaces/TEST/pages/edit-v2/42' } };
    let created: typeof activePage | undefined;
    let upload = false;
    let uploadRequest = '';
    let uploadOrigin = '';
    let label = 'existing';
    let comment = '';
    let putCount = 0;
    let conflict = false;
    let trash = false;

    await browser.route(cloud + '/wiki/spaces/TEST/pages/edit-v2/42', route => route.fulfill({
      contentType: 'text/html',
      body: `<div class="ProseMirror" contenteditable="true">Fixture editor</div>
        <input type="file" data-testid="media-picker-file-input" hidden>
        <script>document.querySelector('input').addEventListener('change', event => {
          const form = new FormData();
          form.append('file', event.target.files[0]);
          void fetch('/wiki/fixture-editor-upload', { method: 'POST', body: form });
        });</script>`,
    }));
    await browser.route(cloud + '/wiki/fixture-editor-upload', async route => {
      uploadRequest = route.request().postData() ?? '';
      uploadOrigin = (await route.request().allHeaders()).origin ?? '';
      upload = true;
      await json(route, { ok: true });
    });

    await tab.route(cloud + '/**', async route => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      const method = request.method();
      if (pathname === '/wiki/home') return route.fulfill({ body: '<title>Test Confluence</title>', contentType: 'text/html' });
      const headers = await request.allHeaders();
      if (!headers.cookie?.includes('fixture-session=signed-in')) return json(route, {}, 401);
      if (pathname === '/wiki/rest/api/user/current') return json(route, { accountId: 'fixture-account', displayName: 'Test user' });
      if (pathname === '/wiki/rest/api/search') {
        const cursor = searchParams.get('cursor');
        const cql = searchParams.get('cql');
        if (cql !== 'type = page AND text ~ "guide"' && cql !== 'type = page') return json(route, {}, 400);
        return json(route, cursor
          ? { results: [{ title: 'Another guide', content: { id: '43', type: 'page' } }] }
          : { results: [{ title: 'Test guide', content: { id: '42', type: 'page' } }],
              _links: { next: '/rest/api/search?cursor=fixture-cursor' } });
      }
      if (pathname === '/wiki/api/v2/spaces') return json(route, { results: [{ id: '10', key: 'TEST', name: 'Test Space' }] });
      if (pathname === '/wiki/api/v2/pages/42' && method === 'GET') return json(route, activePage);
      if (pathname === '/wiki/api/v2/pages/42' && method === 'PUT') {
        putCount++;
        const update = request.postDataJSON();
        if (conflict || update.version.number !== activePage.version.number + 1) return json(route, { message: 'Version number mismatch' }, 400);
        activePage = { ...activePage, ...update, body: stored(update.body.value) };
        return json(route, activePage);
      }
      if (pathname === '/wiki/api/v2/pages/42/direct-children') return json(route, { results: [{ id: '43', type: 'page', title: 'Child guide' }] });
      if (pathname === '/wiki/api/v2/pages/42/footer-comments') return json(route, { results: comment ? [{ id: '15', body: stored(comment) }] : [] });
      if (pathname === '/wiki/api/v2/footer-comments' && method === 'POST') {
        const data = request.postDataJSON();
        if (data.pageId !== '42' || data.body.representation !== 'storage') return json(route, {}, 400);
        comment = data.body.value;
        return json(route, { id: '15' });
      }
      if (pathname === '/wiki/api/v2/pages/42/attachments') return json(route, {
        results: upload ? [{ id: 'att17', title: 'fixture.txt', downloadLink: '/download/attachments/42/fixture.txt' }] : [],
      });
      if (pathname === '/wiki/api/v2/pages/42/labels') return json(route, { results: label ? [{ id: '1', name: label, prefix: 'global' }] : [] });
      if (pathname === '/wiki/rest/api/content/42/label' && method === 'POST') {
        label = request.postDataJSON()[0].name;
        return json(route, { results: [{ name: label }] });
      }
      if (pathname === '/wiki/rest/api/content/42/label' && method === 'DELETE' && searchParams.get('name') === label) {
        label = '';
        return blank(route);
      }
      if (pathname === '/wiki/api/v2/pages' && method === 'POST') {
        const data = request.postDataJSON();
        if (data.spaceId !== '10' || data.parentId !== '42') return json(route, {}, 400);
        created = { ...data, id: '43', _links: { edituiv2: '/spaces/TEST/pages/edit-v2/43' }, version: { number: 1 }, body: stored(data.body.value) };
        return json(route, created);
      }
      if (pathname === '/wiki/api/v2/pages/43' && created && method === 'GET') return json(route, created);
      if (pathname === '/wiki/api/v2/pages/43' && created && method === 'DELETE') {
        trash = true;
        return blank(route);
      }
      return json(route, {}, 404);
    });

    await tab.goto(cloud + '/wiki/home');
    const ui = await browser.newPage();
    await ui.goto(uiUrl + '/workspace.html');
    await ui.getByRole('button', { name: 'Connect tab' }).click();
    await expect(ui.getByText('Test user')).toBeVisible();
    await ui.getByRole('button', { name: 'List spaces' }).click();
    await expect(ui.getByText('Test Space', { exact: true })).toBeVisible();
    await ui.getByRole('searchbox').fill('guide');
    await ui.getByRole('button', { name: 'Search', exact: true }).click();
    await ui.getByRole('button', { name: 'Next results' }).click();
    await expect(ui.getByRole('button', { name: 'Another guide' })).toBeVisible();
    await ui.getByLabel('Query type').selectOption('cql');
    await ui.getByRole('searchbox').fill('type = page');
    await ui.getByRole('button', { name: 'Search', exact: true }).click();
    await ui.getByRole('button', { name: 'Test guide', exact: true }).click();
    await expect(ui.getByText('<p>Original</p>', { exact: true })).toBeVisible();

    await ui.getByRole('button', { name: 'Edit page' }).click();
    await ui.getByLabel('Storage markup').fill('<p>Updated</p>');
    await ui.getByRole('button', { name: 'Save changes' }).click();
    await expect(ui.getByText('Page 42 · Version 4')).toBeVisible();
    await expect(ui.getByText('<p>Updated</p>', { exact: true })).toBeVisible();
    conflict = true;
    await ui.getByRole('button', { name: 'Edit page' }).click();
    await ui.getByLabel('Storage markup').fill('<p>Stale change</p>');
    await ui.getByRole('button', { name: 'Save changes' }).click();
    await expect(ui.getByRole('alert')).toContainText('version conflict');
    expect(putCount).toBe(2);
    await ui.getByRole('button', { name: 'Cancel', exact: true }).click();

    await ui.getByRole('button', { name: 'Children', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'Child guide' })).toBeVisible();
    await ui.getByRole('button', { name: 'Comments', exact: true }).click();
    await ui.getByLabel('Comment storage markup').fill('<p>A fixture comment</p>');
    await ui.getByRole('button', { name: 'Add comment' }).click();
    await expect(ui.getByText('<p>A fixture comment</p>', { exact: true })).toBeVisible();

    await ui.getByRole('button', { name: 'Attachments', exact: true }).click();
    await ui.getByLabel('Attachment (up to 512 KiB)').setInputFiles({
      name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture upload'),
    });
    const editor = browser.waitForEvent('page');
    await ui.getByRole('button', { name: 'Upload attachment' }).click();
    const editorPage = await editor;
    // Chrome opened the editor tab itself, before Playwright attached per-page
    // request routing. Navigate once on the attached page to serve the fixture.
    await editorPage.goto(cloud + '/wiki/spaces/TEST/pages/edit-v2/42');
    await expect(editorPage.locator('.ProseMirror')).toBeVisible({ timeout: 12000 });
    await expect(ui.getByRole('link', { name: 'fixture.txt' })).toHaveAttribute('href', cloud + '/wiki/download/attachments/42/fixture.txt', { timeout: 12000 });
    expect(uploadRequest).toContain('filename="fixture.txt"');
    expect(uploadRequest).toContain('fixture upload');
    expect(uploadOrigin).toBe(cloud);

    await ui.getByRole('button', { name: 'Labels', exact: true }).click();
    await ui.getByLabel('Label name').fill('verified-label');
    await ui.getByRole('button', { name: 'Add label' }).click();
    await expect(ui.getByText('verified-label', { exact: true })).toBeVisible();
    await ui.getByRole('button', { name: 'Remove', exact: true }).click();
    await ui.getByRole('button', { name: 'Confirm removal' }).click();
    await expect(ui.getByText('No labels on this page.')).toBeVisible();

    await ui.getByRole('button', { name: 'Page', exact: true }).click();
    await ui.getByRole('button', { name: 'Create child' }).click();
    await expect(ui.getByLabel('Parent page ID (optional)')).toHaveValue('42');
    await ui.getByLabel('Page title').fill('New fixture page');
    await ui.getByLabel('Storage markup').fill('<p>Fixture</p>');
    await ui.getByRole('button', { name: 'Publish page' }).click();
    await expect(ui.getByRole('heading', { name: 'New fixture page' })).toBeVisible();
    await ui.getByRole('button', { name: 'Move to trash' }).click();
    expect(trash).toBe(false);
    await ui.getByRole('button', { name: 'Confirm trash' }).click();
    await expect(ui.getByText('Page moved to trash.')).toBeVisible();
    expect(trash).toBe(true);

    await tab.reload();
    await expect(ui.getByRole('button', { name: 'Connect tab' })).toBeVisible();
  } finally { await close(); }
});

test('Data Center uses the selected context, offset pagination and v1 request bodies', async () => {
  const { browser, close, uiUrl } = await openExtension(dataCenter);
  try {
    const tab = await browser.newPage();
    await tab.route(dataCenter + '/**', async route => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      if (pathname === '/company/confluence/dashboard') return route.fulfill({ body: '<title>Data Center fixture</title>', contentType: 'text/html' });
      if (pathname === '/company/confluence/rest/api/user/current') return json(route, { userKey: 'fixture', displayName: 'Data Center user' });
      if (pathname === '/company/confluence/rest/api/space') return json(route, searchParams.has('start')
        ? { results: [{ id: 22, key: 'DOCS', name: 'Documentation' }] }
        : { results: [{ id: 11, key: 'FIRST', name: 'First space' }], _links: { next: '?start=25' } });
      if (pathname === '/company/confluence/rest/api/content' && request.method() === 'POST') {
        const data = request.postDataJSON();
        if (data.space?.key === 'DOCS' && data.type === 'page' && data.body?.storage?.value === '<p>DC</p>') {
          return json(route, { id: '50' });
        }
        return json(route, {}, 400);
      }
      if (pathname === '/company/confluence/rest/api/content/50') return json(route, {
        id: '50', title: 'DC page', space: { key: 'DOCS' }, type: 'page', version: { number: 1 }, body: stored('<p>DC</p>'),
      });
      return json(route, {}, 404);
    });
    await tab.goto(dataCenter + '/company/confluence/dashboard');
    const ui = await browser.newPage();
    await ui.goto(uiUrl + '/sidepanel.html');
    await ui.getByLabel('Deployment').selectOption('data-center');
    await ui.getByLabel('Context path').fill('/company/confluence');
    await ui.getByRole('button', { name: 'Connect tab' }).click();
    await expect(ui.getByText('Data Center user')).toBeVisible();
    await ui.getByRole('button', { name: 'List spaces' }).click();
    await ui.getByRole('button', { name: 'Next spaces' }).click();
    await expect(ui.getByText('Documentation', { exact: true })).toBeVisible();
    await ui.getByRole('button', { name: 'New page in this space' }).click();
    await expect(ui.getByLabel('Space key')).toHaveValue('DOCS');
    await ui.getByLabel('Page title').fill('DC page');
    await ui.getByLabel('Storage markup').fill('<p>DC</p>');
    await ui.getByRole('button', { name: 'Publish page' }).click();
    await expect(ui.getByRole('heading', { name: 'DC page' })).toBeVisible();
  } finally { await close(); }
});

test('Sidebar runs versioned scripts with activity logs and keeps Jira bound independently', async () => {
  const jira = 'https://jira-fixture.atlassian.net';
  const { browser, close, uiUrl } = await openExtension(cloud, jira);
  try {
    const confluence = await browser.newPage();
    let page = { id: '42', title: 'Original title', version: { number: 1 }, body: stored('<p>old old</p>') };
    await confluence.route(cloud + '/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/wiki/home') return route.fulfill({ body: '<title>Confluence fixture</title>', contentType: 'text/html' });
      if (pathname === '/wiki/rest/api/user/current') return json(route, { accountId: 'cf-signed-in', displayName: 'Confluence user' });
      if (pathname === '/wiki/rest/api/search') return json(route, { results: [{ title: page.title, content: { id: page.id, type: 'page' } }] });
      if (pathname === '/wiki/api/v2/pages/42') {
        if (route.request().method() === 'PUT') {
          const data = route.request().postDataJSON();
          if (data.version.number !== page.version.number + 1) return json(route, {}, 409);
          page = { ...page, title: data.title, version: data.version, body: stored(data.body.value) };
        }
        return json(route, page);
      }
      return json(route, {}, 404);
    });
    const jiraTab = await browser.newPage();
    let jiraComment: unknown;
    await jiraTab.route(jira + '/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/jira/projects') return route.fulfill({ body: '<title>Jira fixture</title>', contentType: 'text/html' });
      if (url.pathname === '/rest/api/3/myself') return json(route, { accountId: 'jira-signed-in', displayName: 'Jira user' });
      if (url.pathname === '/rest/api/3/search/jql') {
        expect(url.searchParams.get('jql')).toBe('project = TEST');
        return json(route, { issues: [{ key: 'TEST-1', fields: { summary: 'Fixture issue' } }], isLast: true });
      }
      if (url.pathname === '/rest/api/3/issue/TEST-1/comment') {
        jiraComment = route.request().postDataJSON();
        return json(route, { id: '7' }, 201);
      }
      return json(route, {}, 404);
    });
    await confluence.goto(cloud + '/wiki/home');
    await jiraTab.goto(jira + '/jira/projects');

    const ui = await browser.newPage();
    await ui.goto(uiUrl + '/sidepanel.html');
    await ui.getByRole('button', { name: 'Connect tab' }).click();
    await expect(ui.getByText('Confluence user')).toBeVisible();
    await ui.getByRole('button', { name: 'Scripts', exact: true }).click();
    await ui.getByRole('textbox', { name: 'Keyword', exact: true }).fill('fixture');
    await ui.getByRole('button', { name: 'Run query' }).click();
    await ui.getByRole('button', { name: 'Original title', exact: true }).click();
    await expect(ui.getByRole('log')).toContainText('Selected page 42, version 1.');
    await ui.getByRole('button', { name: 'Open in Change' }).click();
    await ui.getByLabel('Page title').fill('Edited from sidebar');
    await ui.getByRole('button', { name: 'Run change' }).click();
    await expect(ui.getByRole('log')).toContainText('Saved page 42, version 2.');
    await ui.getByRole('button', { name: 'Replace', exact: true }).click();
    await ui.getByLabel('Find exact text').fill('old');
    await ui.getByLabel('Replace with').fill('new');
    await ui.getByRole('button', { name: 'Preview replacement' }).click();
    await expect(ui.getByText('Page 42, version 2 · 2 matches')).toBeVisible();
    expect(page.body.storage.value).toBe('<p>old old</p>');
    await ui.getByRole('button', { name: 'Apply replacement' }).click();
    await expect(ui.getByRole('log')).toContainText('Updated 1 of 1 planned pages.');
    expect(page.body.storage.value).toBe('<p>new new</p>');

    await ui.getByRole('button', { name: 'Jira', exact: true }).click();
    await ui.getByRole('button', { name: 'Connect tab' }).click();
    await expect(ui.getByText('Jira user', { exact: true })).toBeVisible();
    await ui.getByLabel('Inputs as JSON').fill('{"jql":"project = TEST"}');
    await ui.getByRole('button', { name: 'Run tool' }).click();
    await expect(ui.getByLabel('Tool result')).toContainText('TEST-1');
    await ui.getByLabel('Tool', { exact: true }).selectOption('jira_add_comment');
    await ui.getByLabel('Inputs as JSON').fill('{"issue":"TEST-1","text":"Sidebar comment"}');
    await ui.getByRole('button', { name: 'Run tool' }).click();
    await expect(ui.getByLabel('Tool result')).toContainText('"id": "7"');
    expect(jiraComment).toEqual({ body: { version: 1, type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Sidebar comment' }] },
    ] } });
    await ui.getByRole('button', { name: 'Scripts', exact: true }).click();
    await expect(ui.getByText('Confluence user')).toBeVisible();
    await expect(ui.getByRole('log')).toContainText('Updated 1 of 1 planned pages.');
    await ui.getByText('Run script from JSON', { exact: true }).click();
    await ui.getByLabel('Script JSON').fill('{"command":"select","pageId":"42"}');
    await ui.getByRole('button', { name: 'Run JSON script' }).click();
    await expect(ui.getByRole('log')).toContainText('Selected page 42, version 3.');
  } finally { await close(); }
});

test('Audit runs from sidebar filters and JSON and distinguishes broken links, images, and unchecked hosts', async () => {
  const { browser, close, uiUrl } = await openExtension(cloud);
  try {
    const tab = await browser.newPage();
    const cqls: string[] = [];
    await tab.route(cloud + '/**', async route => {
      const { pathname, searchParams } = new URL(route.request().url());
      const method = route.request().method();
      if (pathname === '/wiki/home') return route.fulfill({ body: '<title>Audit fixture</title>', contentType: 'text/html' });
      if (pathname === '/wiki/rest/api/user/current') return json(route, { accountId: 'audit-fixture', displayName: 'Audit user' });
      if (pathname === '/wiki/api/v2/spaces') return json(route, { results: [{ id: '10', key: 'DOCS', name: 'Documentation' }] });
      if (pathname === '/wiki/rest/api/search') {
        cqls.push(searchParams.get('cql') ?? '');
        return json(route, { results: [{ title: 'Audit fixture', content: { type: 'page', id: '42' } }] });
      }
      if (pathname === '/wiki/api/v2/pages/42') return json(route, {
        id: '42', title: 'Audit fixture', version: { number: 1 }, _links: { webui: '/spaces/DOCS/pages/42/Audit' },
        body: stored(
          '<h2>Setup</h2><a href="https://docs.example.org/guide">Docs</a><a href="https://docs.example.org/guide">Again</a>'
          + '<a href="/wiki/pages/viewpage.action?pageId=99">Missing page</a><ac:image><ri:attachment ri:filename="missing.png" /></ac:image>'
          + '<img src="/wiki/images/logo.png" alt="Working logo" /><a href="#duplicate"></a>'
          + '<span id="duplicate"></span><span id="duplicate"></span>'
          + '<h2>Footer</h2><a href="https://example.net/unrelated">Footer website</a>',
        ),
      });
      if (pathname === '/wiki/api/v2/pages/42/attachments') {
        expect(searchParams.get('filename')).toBe('missing.png');
        return json(route, { results: [] });
      }
      if (pathname === '/wiki/images/logo.png' && method === 'HEAD') return route.fulfill({ status: 200, contentType: 'image/png' });
      return json(route, {}, 404);
    });
    await tab.goto(cloud + '/wiki/home');
    const ui = await browser.newPage();
    await ui.goto(uiUrl + '/sidepanel.html');
    await ui.getByRole('button', { name: 'Connect tab' }).click();
    await expect(ui.getByText('Audit user', { exact: true })).toBeVisible();
    await ui.getByRole('button', { name: 'Search & Audit', exact: true }).click();
    await ui.getByRole('button', { name: 'Load spaces', exact: true }).click();
    await expect(ui.locator('datalist option')).toHaveCount(1);
    await ui.getByLabel('Space key').fill('DOCS');
    await ui.getByLabel('Branch page ID').fill('42');
    await ui.getByLabel('Section heading').fill('Setup');
    await ui.getByRole('button', { name: 'Run audit', exact: true }).click();
    await expect(ui.getByRole('region', { name: 'Audit totals' }).getByText('1 / 1')).toBeVisible();
    await expect(ui.getByRole('region', { name: 'Audit results' }).getByText('Missing page', { exact: true })).toBeVisible();
    expect(cqls[0]).toContain('space = "DOCS" AND (id = 42 OR ancestor = 42)');
    await expect(ui.getByRole('region', { name: 'Audit results' })).not.toContainText('Footer website');
    await ui.getByLabel('Status filter').selectOption('broken');
    await expect(ui.getByRole('list', { name: 'Reference findings' })).toContainText('missing.png');
    await expect(ui.getByRole('list', { name: 'Reference findings' })).not.toContainText('Working logo');
    await ui.getByText('Content checks (3)', { exact: true }).click();
    await expect(ui.getByText('Duplicate anchor', { exact: true })).toBeVisible();
    await ui.getByText('Repeated destinations (1)', { exact: true }).click();
    await expect(ui.getByText('2 references across 1 page', { exact: true })).toBeVisible();

    await ui.getByRole('button', { name: 'JSON', exact: true }).click();
    await ui.getByLabel('Audit JSON').fill(JSON.stringify({
      scope: { pageId: '42' }, find: { domain: 'example.org', type: 'links' }, checks: { enabled: false, contentQuality: false },
    }));
    await ui.getByRole('button', { name: 'Run audit', exact: true }).click();
    const findings = ui.getByRole('list', { name: 'Reference findings' });
    await expect(findings).toContainText('Docs');
    await expect(findings).toContainText('Unchecked');
    await expect(findings).not.toContainText('Footer website');
    await expect(ui.getByRole('region', { name: 'Audit results' }).getByRole('button', { name: 'Download JSON' })).toBeVisible();
  } finally { await close(); }
});

test('Whole-space audit loads batches, exports reports, and applies only reviewed link repairs', async () => {
  const { browser, close, uiUrl } = await openExtension(cloud);
  try {
    const sourceUrl = cloud + '/wiki/spaces/DOCS/pages/42/Setup';
    const tab = await browser.newPage();
    const old = '/wiki/pages/viewpage.action?pageId=99';
    const original = `<h2>Setup</h2><p>=plain text ${old}</p><a title="Keep" href="${old}">=Broken</a>`;
    const pages = new Map([
      ['42', { id: '42', title: 'Setup', version: { number: 3 }, body: stored(original) }],
      ['43', { id: '43', title: 'Details', version: { number: 5 }, body: stored(original) }],
    ]);
    let writes = 0;

    await tab.route(cloud + '/**', async route => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      if (request.url() === sourceUrl) return route.fulfill({ body: '<title>Setup - Fixture</title>', contentType: 'text/html' });
      if (pathname === '/wiki/rest/api/user/current') return json(route, { accountId: 'workspace-user', displayName: 'Workspace user' });
      if (pathname === '/wiki/api/v2/spaces') return json(route, { results: [{ id: '10', key: 'DOCS', name: 'Documentation' }] });
      if (pathname === '/wiki/api/v2/spaces/10/pages') return json(route, searchParams.has('cursor')
        ? { results: [pages.get('43')] }
        : { results: [pages.get('42')], _links: { next: '/wiki/api/v2/spaces/10/pages?cursor=second' } });
      const id = pathname.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/)?.[1];
      const page = id ? pages.get(id) : undefined;
      if (!page || !id) return json(route, {}, 404);
      if (request.method() === 'PUT') {
        writes++;
        const update = request.postDataJSON();
        if (update.version.number !== page.version.number + 1) return json(route, {}, 409);
        pages.set(id, { ...page, version: update.version, body: stored(update.body.value) });
        return json(route, pages.get(id));
      }
      return json(route, page);
    });
    await tab.goto(sourceUrl);
    const ui = await browser.newPage();
    await ui.goto(uiUrl + '/sidepanel.html');
    await ui.getByRole('button', { name: 'Connect tab' }).click();
    await expect(ui.getByText('Workspace user', { exact: true })).toBeVisible();
    await ui.getByRole('button', { name: 'Search & Audit', exact: true }).click();
    await expect(ui.getByRole('button', { name: 'Use current page · 42' })).toBeVisible();
    await ui.getByRole('button', { name: 'Load spaces', exact: true }).click();
    await expect(ui.locator('#audit-spaces option')).toHaveCount(1);
    await ui.getByLabel('Space key').fill('DOCS');
    await ui.getByText('Query and select pages', { exact: true }).click();
    await ui.getByRole('button', { name: 'Load matching pages' }).click();
    await expect(ui.getByText('2 pages loaded · 0 selected')).toBeVisible();
    await ui.getByLabel(/Audit all matching pages/).check();
    await ui.getByRole('button', { name: 'Run audit', exact: true }).click();
    const results = ui.getByRole('region', { name: 'Audit results' });
    await expect(results).toContainText('2 / 2');
    await expect(results).toContainText('2 unique page connections');
    const jsonDownload = ui.waitForEvent('download');
    await ui.getByRole('button', { name: 'Download JSON' }).click();
    const report = JSON.parse(await readFile((await (await jsonDownload).path())!, 'utf8'));
    expect(report.counts.broken).toBe(2);
    expect(report.limited).toBe(false);
    const csvDownload = ui.waitForEvent('download');
    await ui.getByRole('button', { name: 'Download CSV' }).click();
    expect(await readFile((await (await csvDownload).path())!, 'utf8')).toContain('"\'=Broken"');

    await ui.getByText('Bulk link repair', { exact: true }).click();
    await ui.getByLabel('Replacement URL').fill('/wiki/guide?a=1&b=2');
    await ui.getByRole('button', { name: 'Preview repairs' }).click();
    await expect(ui.getByRole('heading', { name: 'Repair preview' })).toBeVisible();
    await expect(ui.locator('.repair-diff del')).toHaveCount(2);
    expect(writes).toBe(0);
    const stale = pages.get('43')!;
    pages.set('43', { ...stale, version: { number: 6 } });
    await ui.getByRole('button', { name: 'Apply to 2 selected pages' }).click();
    await expect(ui.getByRole('region', { name: 'Repair results' })).toContainText('1 page updated');
    await expect(ui.getByRole('region', { name: 'Repair results' })).toContainText('Page version changed since preview.');
    expect(writes).toBe(1);
    expect(pages.get('42')!.body.storage.value).toBe(`<h2>Setup</h2><p>=plain text ${old}</p><a title="Keep" href="/wiki/guide?a=1&amp;b=2">=Broken</a>`);
    expect(pages.get('43')!.body.storage.value).toBe(original);
  } finally { await close(); }
});

test('Planner conversion previews cards, reuses template steps, and downloads a Jira hierarchy', async () => {
  const { browser, close, uiUrl } = await openExtension(cloud);
  try {
    const ui = await browser.newPage();
    await ui.goto(uiUrl + '/workspace.html');
    await ui.getByRole('button', { name: 'Planner conversion' }).click();
    const input = ui.getByLabel('Planner export JSON');
    const tasks = [
      { title: 'Implementation template', checklist: [{ title: 'Confirm scope' }, { title: 'Review reporting', isChecked: true }] },
      { title: 'Example, "clinic"', id: 'card-2', bucket: 'Blocked', labels: ['Implementation'], dueDateTime: '2027-01-15T12:00:00Z',
        percentComplete: 50, description: 'Note one\nNote two', checklist: [{ title: 'Confirm scope', isChecked: true }] },
    ];
    await input.setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ plan: { title: 'Example' }, tasks })) });
    await ui.getByLabel('Standard checklist for cards labeled Implementation').selectOption('0');
    await expect(ui.getByRole('status')).toContainText('1 card and 2 checklist subtasks');
    await ui.getByText('Preview work items', { exact: true }).click();
    await expect(ui.getByRole('listitem').filter({ hasText: 'Example, "clinic"' })).toContainText('Due 2027-01-15');
    await expect(ui.locator('li time')).toHaveCount(1);
    const pending = ui.waitForEvent('download');
    await ui.getByRole('button', { name: 'Download Jira CSV' }).click();
    const download = await pending;
    const csv = await readFile((await download.path())!, 'utf8');
    expect(csv).not.toContain('bucket-Blocked');
    expect(csv).not.toContain('planner-card');
    expect(csv).toContain('"1","","Task","Example, ""clinic"""');
    expect(csv).toContain('Note one\nNote two');
    expect(csv).toContain('"In Progress","","","2027-01-15","Implementation"');
    expect(csv).toContain('"2","1","Sub-task","Confirm scope"');
    expect(csv).toContain('"Done","","","",""');
    expect(csv).toContain('"3","1","Sub-task","Review reporting"');
    expect(csv).toContain('"To Do","","","",""');
    await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"plan":{},"tasks":[{}]}') });
    await expect(ui.getByRole('alert')).toContainText('tasks.0.title');
    await expect(ui.getByRole('button', { name: 'Download Jira CSV' })).toHaveCount(0);
  } finally { await close(); }
});

test('Planner heading export follows Jira pagination and carries current summaries and links', async () => {
  const jira = 'https://jira-fixture.atlassian.net';
  const { browser, close, uiUrl } = await openExtension(jira);
  try {
    const tab = await browser.newPage();
    await tab.route(jira + '/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/jira/projects') return route.fulfill({ contentType: 'text/html', body: '<title>Test Jira</title>' });
      if (url.pathname === '/rest/api/3/myself') return json(route, { accountId: 'user', displayName: 'Test user' });
      if (url.pathname === '/rest/api/3/search/jql') {
        expect(url.searchParams.get('jql')).toContain('project = "TEST" ORDER BY key');
        const next = url.searchParams.get('nextPageToken');
        const key = next ? 'TEST-2' : 'TEST-1';
        return json(route, { issues: [{ key, properties: next ? {plannerSource:'planner-src-fixture'} : {}, fields: { labels:next ? [] : ['planner-card'], issuetype:{subtask:false}, summary: 'Current ' + key, status: { name: 'Done' } } }],
          ...(next ? { isLast: true } : { nextPageToken: 'next' }) });
      }
      return json(route, {}, 404);
    });
    await tab.goto(jira + '/jira/projects');
    const ui = await browser.newPage();
    await ui.goto(uiUrl + '/workspace.html');
    await ui.getByRole('button', { name: 'Jira', exact: true }).click();
    await ui.getByRole('button', { name: 'Connect tab' }).click();
    await expect(ui.getByText('Test user', { exact: true })).toBeVisible();
    await ui.getByRole('button', { name: 'Planner conversion' }).click();
    await ui.getByLabel('Jira project key').fill('test');
    const pending = ui.waitForEvent('download');
    await ui.getByRole('button', { name: 'Download Planner CSV' }).click();
    const csv = await readFile((await (await pending).path())!, 'utf8');
    expect(csv).toContain('"OutlineNumber","Title","Bucket","Description"');
    expect(csv).toContain('"2","Current TEST-2","Done","' + jira + '/browse/TEST-2');
    await expect(ui.getByRole('status')).toContainText('Exported 2 Jira headings.');
  } finally { await close(); }
});

test('direct Planner transfer adopts a CSV parent, creates a child, resumes and preserves subsequent Jira changes', async () => {
  const jira = 'https://jira-fixture.atlassian.net';
  const { browser, close, uiUrl } = await openExtension(jira);
  type Fields = {project:{key:string}; summary:string; labels:string[]; issuetype:{id:string;subtask:boolean};
    status:{name:string}; description: unknown; parent?:{key:string}; start?:string; duedate?:string};
  const issues = new Map<string,Fields>([['TEST-5',{project:{key:'TEST'}, summary:'Pilot', labels:['planner-card'],
    issuetype:{id:'10',subtask:false},status:{name:'To Do'},description:'Original notes\nid: c-1'}]]);
  const properties = new Map<string,Record<string,string>>();
  const links = new Map<string,string>();
  const categoryOptions = new Map([['Active','110']]);
  let interrupted = true;
  try {
    const tab = await browser.newPage();
    await tab.route(jira+'/**', async route=>{
      const url = new URL(route.request().url());
      const method=route.request().method();
      const path=url.pathname.replace('/rest/api/3/','');
      if(path==='/jira/projects') return route.fulfill({contentType:'text/html',body:'<title>Test Jira</title>'});
      if(path==='myself') return json(route,{accountId:'user',displayName:'Test user'});
      if(path==='project/TEST') return json(route,{id:'100',key:'TEST',issueTypes:[{id:'10',name:'Task',subtask:false},{id:'11',name:'Sub-task',subtask:true}]});
      if(path.startsWith('issue/createmeta/TEST/issuetypes/')) return json(route,{total:2,fields:[{fieldId:'priority',allowedValues:[{name:'Urgent'}]},{
        fieldId:'category',schema:{custom:'com.atlassian.jira.plugin.system.customfieldtypes:jwm-category'},
        allowedValues:[...categoryOptions].map(([value,id])=>({id,value})),
      }]});
      if(url.pathname==='/rest/gira/1/'){
        const body=route.request().postDataJSON();
        expect(body.operationName).toBe('JwmCreateCategory');expect(body.variables.input.projectId).toBe('100');
        const {value}=body.variables.input;expect(value).toBe('Empty bucket');expect(categoryOptions.has(value)).toBe(false);
        categoryOptions.set(value,'111');
        return json(route,{data:{createJwmCategory:{success:true,category:{option:{value,optionId:'111'}}}}});
      }
      if(path==='user/assignable/search') {
        expect(url.searchParams.get('project')).toBe('TEST');
        return json(route,[{accountId:'pilot-owner',displayName:'Pilot in Jira',emailAddress:'pilot@example.org',active:true},{accountId:'other',displayName:'Pilot owner',emailAddress:'other@example.org',active:true}]);
      }
      if(path==='search/jql') return json(route,{issues:[...issues].map(([key,fields])=>({key,fields,properties:properties.get(key)}))});
      if(path==='issue' && method==='POST'){
        const f=route.request().postDataJSON().fields;
        const key='TEST-'+(issues.size+5);
        properties.set(key,{plannerSource:route.request().postDataJSON().properties[0].value});
        issues.set(key,{...f,project:{key:'TEST'},issuetype:{...f.issuetype,subtask:!!f.parent},status:{name:'To Do'}});
        return json(route,{key},201);
      }
      const [,key,op]=path.split('/');
      const issue=issues.get(key);
      if(!issue)return json(route,{},404);
      if(op==='editmeta') return json(route,{fields:{
        customfield_88:{name:'Planner owners',schema:{type:'array',items:'user'}},
        start:{name:'Start date',schema:{type:'date'}},timetracking:{name:'Time tracking'},
        ...Object.fromEntries(['Readiness Assessment','Complexity Score','Ticket #'].map((name,index) =>
          ['customfield_'+index,{name,schema:{type:'string',custom:'com.atlassian.jira.plugin.system.customfieldtypes:textfield'}}])),
      }});
      if(op==='remotelink') {
        if(method==='GET') return json(route,[...links.values()].map(url=>({object:{url}})));
        const link=route.request().postDataJSON();
        links.set(link.globalId,link.object.url);
        return json(route,{id:links.size});
      }
      if(op==='transitions'){
        if(method==='GET')return json(route,{transitions:[{id:'1',to:{name:'Done'}}]});
        if(interrupted){interrupted=false;return json(route,{},429);}
        issue.status={name:'Done'};return blank(route);
      }
      if(method==='PUT'){
        const body=route.request().postDataJSON();
        if(op==='assignee'){expect(body.accountId).toBe('pilot-owner');Object.assign(issue,{assignee:{accountId:body.accountId,displayName:'Pilot owner'}});return blank(route);}
        if(body.properties) properties.set(key,{plannerSource:body.properties[0].value});
        const update=body.fields;
        if(update.description===null) update.description={type:'doc',version:1,content:[]};
        if(update.timetracking) {
          expect(update.timetracking).toEqual({originalEstimate:'120m',remainingEstimate:'90m'});
          update.timetracking={originalEstimateSeconds:7200,remainingEstimateSeconds:5400};
        }
        Object.assign(issue,update);return blank(route);
      }
      return json(route,{key,fields:issue,properties:properties.get(key)});
    });
    await tab.goto(jira+'/jira/projects');
    const popup=await browser.newPage();
    await popup.goto(uiUrl+'/index.html');
    const opened=browser.waitForEvent('page');
    await popup.getByRole('button',{name:'Open Planner importer'}).click();
    const ui=await opened;
    await ui.waitForURL('**/workspace.html#planner');
    await ui.getByRole('button',{name:'Connect tab'}).click();
    await expect(ui.getByText('Test user',{exact:true})).toBeVisible();
    const input={source:'planner-browser',plan:{id:'plan',title:'Original',url:'https://planner.cloud.microsoft/sample'},plannerRecords:{resources:[{id:'r1',name:'Pilot owner',userPrincipalName:'pilot@example.org'}],assignments:[{taskId:'c-1',resourceId:'r1'}],buckets:[{id:'b1',name:'Active'},{id:'b2',name:'Empty bucket'}]},tasks:[
      {id:'c-1',title:'Pilot',bucket:'Active',assignedTo:['Pilot owner'],priority:'Medium',labels:['pilot'],duration:3600,work:7200,actualWork:1800,remainingWork:5400,
       percentComplete:0,conversationReferences:[{teamsConversationId:'example-thread'}],
       history:{state:'complete',events:[{editType:'TaskCreated',timestamp:'2026-10-10T00:00:00Z'}]},
       customFields:{'Readiness Assessment':'Ready','Complexity Score':'Not complex','Ticket #':'SCTASK01 A2'},
       startDateTime:'2026-11-23',dueDateTime:'2027-12-31',attachments:[{name:'Document',uri:'https://example.org/document'}],
        checklist:[{id:'i-1',title:'Review',isChecked:true}]},
    ]};
    const parsed = plannerFile.parse(input);
    const parentIssue = issues.get('TEST-5')!;
    parentIssue.description = legacyPlannerDescription(parsed,parsed.tasks[0]);
    parentIssue.start = '2026-11-23';
    parentIssue.duedate = '2027-12-31';
    await ui.getByLabel('Planner export JSON').setInputFiles({name:'pilot.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(input))});
    await ui.getByLabel('Jira project key').fill('TEST');
    const run=ui.getByRole('button',{name:'Import directly into TEST'});
    await ui.getByLabel('Match existing Jira work items only').check();
    await run.click();
    await expect(ui.getByText(/No existing Jira match for Review/)).toBeVisible();
    expect(issues.size).toBe(1);
    expect(parentIssue.start).toBe('2026-11-23');
    expect(parentIssue.duedate).toBe('2027-12-31');
    expect(parentIssue.description).toMatchObject({type:'doc',content:expect.arrayContaining([
      expect.objectContaining({type:'heading',content:[{type:'text',text:'Attachments'}]})
    ])});
    const currentDescription = () => JSON.stringify(parentIssue.description);
    for(const omitted of ['Change history','Working duration','Total effort','Completed effort','Remaining effort','Planner owners:','Bucket:','Labels:','Schedule','Planner source','Planner card ID:','Plan: Original','Priority: Medium','Progress','Related work','example-thread']) {
      expect(currentDescription()).not.toContain(omitted);
    }
    expect(parentIssue).toMatchObject({customfield_0:'Ready',customfield_1:'Not complex',customfield_2:'SCTASK01 A2'});
    const rerun = async () => {
      await run.click();
      await expect(ui.getByText(/No existing Jira match for Review/)).toBeVisible();
    };
    expect(parentIssue.labels).toEqual(['pilot']);
    expect(parentIssue).toHaveProperty('assignee.accountId','pilot-owner');
    expect(parentIssue).toHaveProperty('customfield_88',[{accountId:'pilot-owner'}]);
    const copyPlan=ui.getByLabel(/Include Planner source details/);
    const copyPriority=ui.getByLabel('Include Planner priority in the description');
    const progressText=ui.getByLabel('Include Planner progress and status in the description');
    const scheduleText=ui.getByLabel('Include Planner start and finish in the description');
    const conversations=ui.getByLabel('Include Teams conversation references in the description');
    for (const option of [progressText,scheduleText,conversations,copyPriority,copyPlan]) await expect(option).not.toBeChecked();
    await progressText.check();await rerun();
    expect(currentDescription()).toContain('Progress: 0%');expect(currentDescription()).not.toContain('Priority: Medium');
    await progressText.uncheck();await scheduleText.check();await rerun();
    expect(currentDescription()).toContain('Start: 2026-11-23');expect(currentDescription()).toContain('Finish: 2027-12-31');
    expect(currentDescription()).not.toContain('Progress:');
    await scheduleText.uncheck();await conversations.check();await rerun();
    expect(currentDescription()).toContain('example-thread');expect(currentDescription()).not.toContain('Schedule');
    await conversations.uncheck();
    await copyPlan.check();await rerun();
    expect(currentDescription()).not.toContain('example-thread');
    expect(currentDescription()).toContain('Plan: Original');
    expect(currentDescription()).toContain('Planner card ID: c-1');
    await copyPlan.uncheck();await copyPriority.check();await rerun();
    expect(currentDescription()).toContain('Priority: Medium');expect(currentDescription()).not.toContain('Plan: Original');
    await copyPriority.uncheck();
    const copyHistory=ui.getByLabel('Include Planner change history in the description');
    const copyEffort=ui.getByLabel('Include Planner duration and effort in the description');
    const copyEstimates=ui.getByLabel(/Copy total and remaining effort/);
    for(const option of [copyHistory,copyEffort,copyEstimates])await expect(option).not.toBeChecked();
    await copyHistory.check();await rerun();
    expect(currentDescription()).toContain('Change history');expect(currentDescription()).not.toContain('Working duration');
    await copyHistory.uncheck();await copyEffort.check();await rerun();
    expect(currentDescription()).toContain('Working duration: 1 hours');expect(currentDescription()).not.toContain('Change history');
    expect(parentIssue).not.toHaveProperty('timetracking');
    await copyEffort.uncheck();await copyEstimates.check();await rerun();
    expect(parentIssue).toHaveProperty('timetracking.originalEstimateSeconds',7200);
    expect(currentDescription()).not.toContain('Working duration');
    parentIssue.description='Edited by a Jira user';
    await ui.getByLabel('Match existing Jira work items only').uncheck();
    await run.click();
    await expect(ui.getByText(/rate limiting requests/)).toBeVisible();
    expect(issues.size).toBe(2);
    await run.click();
    await expect(ui.getByText(/Verified 2 work items in TEST/)).toBeVisible();
    expect(issues.get('TEST-5')?.start).toBe('2026-11-23');
    expect(issues.get('TEST-6')?.status.name).toBe('Done');
    expect(issues.get('TEST-6')?.parent?.key).toBe('TEST-5');
    expect(links.size).toBe(2);
    expect(parentIssue.description).toBe('Edited by a Jira user');
    expect(categoryOptions.size).toBe(2);
    expect(issues.get('TEST-5')).toHaveProperty('category.id','110');
    expect(issues.get('TEST-6')).toHaveProperty('category.id','110');
    await ui.evaluate(() => chrome.storage.local.clear());
    Object.assign(parentIssue,{summary:'Renamed in Jira',assignee:{accountId:'editor',displayName:'Editor'}});
    await run.click();
    await expect(ui.getByText(/Created 0, reused 2/)).toBeVisible();
    expect(parentIssue).toHaveProperty('assignee.accountId','editor');
    expect(issues.get('TEST-6')!.labels).toEqual([]);
    issues.get('TEST-6')!.status={name:'In Progress'};
    await run.click();
    await expect(ui.getByText(/Created 0, reused 2/)).toBeVisible();
    expect(issues.get('TEST-6')?.status.name).toBe('In Progress');
    expect(issues.size).toBe(2);
    parentIssue.description='Planner source\nPlanner card ID: c-1';
    await ui.getByLabel('Planner export JSON').setInputFiles({name:'empty.json',mimeType:'application/json',
      buffer:Buffer.from(JSON.stringify({plan:input.plan,tasks:[{id:'c-1',title:'Pilot'}]}))});
    await run.click();
    await expect(ui.getByText(/Verified 1 work item in TEST/)).toBeVisible();
    expect(parentIssue.description).toEqual({type:'doc',version:1,content:[]});
    await ui.getByLabel('Planner export JSON').setInputFiles({name:'urgent.json',mimeType:'application/json',
      buffer:Buffer.from(JSON.stringify({plan:input.plan,tasks:[{id:'urgent',title:'Urgent card',priority:'Urgent'}]}))});
    await run.click();
    await expect(ui.getByText(/Created 1, reused 0/)).toBeVisible();
    expect(issues.get('TEST-7')).toHaveProperty('priority.name','Urgent');
    const shared = {id:'shared',title:'Shared card',assignedTo:['Missing owner','Pilot in Jira']};
    await ui.getByLabel('Planner export JSON').setInputFiles({name:'shared.json',mimeType:'application/json',
      buffer:Buffer.from(JSON.stringify({plan:input.plan,tasks:[shared]}))});
    await run.click();
    await expect(ui.getByText(/Created 1, reused 0/)).toBeVisible();
    expect(issues.get('TEST-8')).toMatchObject({assignee:null,customfield_88:[{accountId:'pilot-owner'}]});
    Object.assign(issues.get('TEST-8')!,{assignee:{accountId:'team-lead'}});
    await run.click();
    await expect(ui.getByText(/Created 0, reused 1/)).toBeVisible();
    expect(issues.get('TEST-8')).toHaveProperty('assignee.accountId','team-lead');
  } finally {await close();}
});


test('shared cards keep the primary available, sort the configured owner last and report ambiguous accounts', async () => {
  const card = {title:'Shared',assignedTo:['Fixture Manager','Alex Smith','Other Owner']};
  const warnings = new Set<string>();
  const users = [{accountId:'manager',displayName:'Fixture Manager'},{accountId:'other',displayName:'Other Owner'},
    {accountId:'first',displayName:'Alex Smith'},{accountId:'second',displayName:'Alex Smith'}];
  const fields = {customfield_88:[] as {accountId:string}[],assignee:null};
  let writes = 0;
  async function run<T>(tool:string,input:Record<string,unknown>):Promise<T> {
    if (tool==='jira_search_users') return {results:users} as T;
    if (tool==='jira_update_issue') {
      writes++;
      Object.assign(fields,input.fields);
      return {} as T;
    }
    expect(tool).toBe('jira_get_issue');
    return {fields} as T;
  }
  const cache = new Map<string,string[]>();
  expect(plannerOwners(card,'')).toEqual(card.assignedTo);
  expect(plannerOwners(card,'fixture manager')).toEqual(['Alex Smith','Other Owner','Fixture Manager']);
  for (let i=0;i<2;i++) {
    const result = await importPlannerOwners(run,'TEST','TEST-5',card,fields,true,'customfield_88',undefined,cache,warnings,'Fixture Manager');
    expect(result.unmatched).toEqual(['Alex Smith']);
    expect(result.assignee).toBe('');
  }
  expect(writes).toBe(1);
  expect(fields.customfield_88).toEqual([{accountId:'other'},{accountId:'manager'}]);
  expect([...warnings].join(' ')).toContain('2 exact matches');
});

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

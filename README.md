# Confluence Toolkit

A Manifest V3 Chrome extension for searching, editing, and auditing Confluence Cloud and Data Center. It can also connect a separate signed-in Jira tab. Use it from the toolbar popup, the Chrome side panel, or a full workspace tab. The optional local MCP bridge exposes the same operations to an assistant or the included CLI.

## Install in Chrome

Requires Node.js 22 or later and Chrome 120 or later.

```sh
npm ci
npm run build
```

1. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select this project's `build` directory.
2. Sign in to Confluence in Chrome. Open **Confluence Toolkit**, choose the signed-in tab, and click **Connect tab**. Chrome asks for access to that site on first connection.
3. Cloud normally uses `/wiki`. Data Center accepts a path such as `/confluence` or `/company/confluence`. Leave the path empty for an installation at the site root.
4. Open the workspace for a two-column view. Search by keyword or Confluence Query Language (CQL), browse spaces, or open a page by its numeric ID.

Page tools cover storage markup, creation and version-checked edits, direct children, footer comments, label management, and moving a page to the recoverable trash. Attachments list download links that open in signed-in Chrome. New uploads support files up to 512 KiB. On Confluence Cloud, Toolkit opens the signed-in page editor and hands the selected file to Confluence’s native media picker. The attachment list confirms completed uploads. When review is needed, the editor stays open for you to finish or publish any draft changes.

## Connect a local assistant

The native messaging host supports macOS and Linux. The extension can run on its own in Chrome without the host.

```sh
npm run install:host
```

This command registers a user-level native host for Chrome and prints the MCP client configuration with absolute paths. Use `npm run install:host -- chromium` or `npm run install:host -- chrome-for-testing` for those browsers. Keep the project directory in place after registration.

In Confluence Toolkit, expand **Local assistant** and click **Start bridge**. Choose **Read only**, **Edit existing**, **Create and edit**, or **Full access** before starting it. Full access includes destructive tools. The bridge can use separate Confluence and Jira connections. Switching or reloading either connected tab stops the bridge and requires reconnecting that tab.

The MCP server communicates over stdio and a private Unix socket. It exposes 84 tools across Confluence and Jira. The extension's **Confluence tools** and **Jira** views also run those registered operations with structured JSON arguments and no local host. Cloud and Data Center operations use the selected tab’s same-origin session. Chrome keeps the session cookies. Page updates require the version read when preparing the change, and failures are surfaced to the caller for reconciliation.

## Tools in the Chrome side panel

Open **Side panel** from the toolbar popup. Use **Scripts** for keyword or CQL query, page selection, versioned changes, and literal replacement previews. A replacement can target one page or a bounded CQL result set. **Run script from JSON** accepts the same command definitions. Every run writes timestamped status messages to the current tab's activity log, which you can copy or clear.

Example script:

```json
{ "command": "replace", "pageId": "12345", "field": "storage", "find": "Old name", "with": "New name" }
```

Use **Confluence tools** for page history, templates, content restrictions, space permissions, users, page analytics, comments, and attachments. Use **Jira** to connect a separate tab and work with JQL, issues, project metadata, comments, transitions, links, watchers, worklogs, boards, sprints, service desks, queues, requests, and SLAs. Tool availability depends on the product, deployment, permissions, and license.

## Search & Audit

**Search & Audit** scans stored Confluence page content and shows where each reference appears. Start with one page or narrow a page search by space key, branch, label, or CQL filter. Within those pages you can filter by heading, domain, location, URL or link text, and reference type. An ancestor filter includes the branch page and descendants. Provide CQL as a filter expression without an `ORDER BY` clause.

Internal checks use the signed-in tab. The report distinguishes broken targets, redirects, restricted resources, check errors, and unchecked targets. An HTTP 404 can also mean the signed-in account cannot see the destination. Anchor checks use stored IDs, native anchor macros, and headings. Macros can generate additional anchors at runtime. The report includes counts by status and domain, repeated destinations ranked by the number of affected pages, missing image alt attributes, unlabeled links, and duplicate anchors.

Expand **Query and select pages** to preview the page catalog and select specific results. The picker loads the next batch while you scroll. **Use current page** detects a page open in the connected Confluence tab. **Audit all matching pages** follows pagination to the end of the chosen scope. Selecting a space from the catalog lets Cloud read that space’s current pages directly.

The **Graphs** section shows reference status, top domains, and the scanned incoming and outgoing links for a page. **Download CSV** exports findings and skipped pages. **Download JSON** also includes totals, the page catalog, and graph connections.

Under **Bulk link repair**, choose a broken URL and enter its replacement or search for a Confluence destination. Queue multiple mappings and preview the exact changes proposed for each page. Choose the pages to apply. Pages that changed since the preview are skipped and listed in the repair result. The repair targets hyperlink and image URL attributes in storage markup, including external URL references inside native Confluence links and images. Native page-title and attachment-name references appear in the report for review.

Use **JSON** to paste or copy an audit definition. Example:

```json
{
  "scope": { "space": "DOCS", "ancestorId": "12345", "label": "handbook" },
  "find": {
    "type": "all",
    "location": "all",
    "domain": "example.org",
    "includeSubdomains": true,
    "heading": "Setup",
    "ignoreDomains": ["old.example.org"]
  },
  "checks": { "enabled": true, "contentQuality": true, "externalDomains": ["docs.example.org"] },
  "pageLimit": 20
}
```

The domain filter finds references. The external-domain list optionally checks exact HTTPS hosts through Chrome permission prompts. External requests omit credentials and stop at redirects. Leave the list empty to find external references without contacting them. The default run checks up to 80 distinct targets. Increase this budget under **More filters** when needed. Whole-space runs report any skipped pages and whether the run hit a target or export row limit.

Patterns reviewed include [Link Health for Confluence](https://marketplace.atlassian.com/apps/4070096260/link-health-for-confluence), [Broken Links+](https://appsplus.atlassian.net/wiki/spaces/SUPPORT/pages/439123969), [STAGIL Link Tools](https://marketplace.atlassian.com/apps/1215391/link-tools-bulk-editor-graphs-audit-structure), the [W3C Link Checker](https://dev.w3.org/perl/modules/W3C/LinkChecker/docs/checklink), and [Lychee](https://lychee.cli.rs/guides/config/).

## Query, select, change, and replace from the CLI

With the bridge running, run these commands from the project directory. The CLI writes JSON to stdout.

```sh
npm run --silent confluence -- query --text 'deployment' --limit 10
npm run --silent confluence -- query --cql 'space = "DOCS" AND type = page'
npm run --silent confluence -- select --page 12345
npm run --silent confluence -- change --page 12345 --version 7 --title 'Deployment notes'
npm run --silent confluence -- change --page 12345 --version 8 --storage-file ./page-storage.html
```

Pass a returned `nextCursor` as `--cursor` or `nextStart` as `--start` to continue a query. Use the version returned by `select` when you prepare a change. A title-only change preserves the page’s storage markup.

To replace text, save a preview and review its page IDs, expected versions, and match counts before applying it. By default the replacement is literal, case-sensitive, and operates on Confluence storage markup. Use `--field title` for page titles. Markup replacements can affect attributes and macro parameters. An empty `--with ''` removes matches.

```sh
npm run --silent confluence -- replace --page 12345 --find 'Old name' --with 'New name' > replacement.json
npm run --silent confluence -- replace --cql 'space = "DOCS" AND type = page' --limit 20 --find 'Old name' --with 'New name' > space-replacement.json
npm run --silent confluence -- apply --plan replacement.json
```

CQL previews inspect up to 20 matching pages by default and accept `--limit` up to 100. Apply verifies the site, account, original version, and match count before each update. It prints per-page results and exits nonzero when a page fails or has changed since preview.

## Build and verify

```sh
npx playwright install chromium
npm test
npm run package
```

GitHub Actions runs on pushes to `main`, pull requests, and manual dispatch. Download **ConfluenceToolkit** from the artifacts section of a successful run.

The tests exercise the unpacked extension against mocked Cloud and Data Center endpoints, the MCP and native messaging transport, the CLI, and the sidebar’s script and audit flows. The ZIP in `dist/ConfluenceToolkit.zip` contains the unpacked extension files. The native host and CLI run from the project directory.

To verify a live signed-in tenant, run `npm run smoke` with a read-only bridge. With a write-enabled bridge, `npm run smoke -- SPACE` uses the specified disposable Cloud space ID or Data Center space key to publish a temporary test page. It exercises page editing, the CLI, comments, labels, and attachment upload, then moves the test page to the recoverable trash.

## Layout

- `public/` holds the Chrome manifest and HTML entry points.
- `src/chrome/` contains the background worker and tab content script.
- `src/services/` contains Confluence request mapping and extension messaging.
- `src/features/` contains connection and workspace screens.
- `bridge/` contains the native messaging host and MCP server.
- `scripts/` contains build, install, CLI, and live smoke commands.
- `e2e/` contains browser, bridge, and CLI tests.

References for the request and transport designs include [Confluence Cloud REST](https://developer.atlassian.com/cloud/confluence/rest/v2/), [Confluence Data Center REST](https://developer.atlassian.com/server/confluence/rest/latest/), [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Tabkit](https://github.com/brbousnguar/tabkit), and [Atlassian Browser Skills](https://github.com/baekchangjoon/atlassian-browser-skills).

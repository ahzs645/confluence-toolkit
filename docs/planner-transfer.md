# Operating the Planner to Jira transfer

## First-time setup

1. Install Microsoft Planner Exporter from the [source repository](https://github.com/ahzs645/plannerpremium). Load the repository root as an unpacked Chrome extension. The exporter opens a fresh Premium plan tab in the signed-in profile. Collect histories there if you need the audit trail, then download **Jira Toolkit JSON**.
2. In this repository, run `npm ci` and `npm run build` using Node 22 or later. Load **build/** as a second unpacked extension in the profile with access to the destination. After pulling updates, rebuild and click **Reload** on Confluence Toolkit in Chrome.
3. In the destination project's Task layout, make the fields below editable. For a team-managed space, use **Space settings → Work types → Task**. The owner script finds fields by name and schema, so field IDs can differ across projects.
4. Open **Open Planner importer** from the toolkit popup. Connect the signed-in Jira tab, load the JSON, enter the destination key and check the preview counts. For a complete transfer including closed cards, leave the template selector empty. Selecting a template excludes that source card and can add checklist steps to other cards.
5. On a first import choose **Import directly into [project]**. On a subsequent reconciliation use **Match existing Jira work items only**. Keep the workspace open until verification completes. Both modes can write to matched issues. The browser workflow uses the connected tab directly.

## What appears on the Jira card

| Planner value | Destination and behavior |
| --- | --- |
| Task and checklist item | Task and child Sub-task. Partial checklists from an Excel export can require manual completion review. |
| Start and finish | Native editable start-date field and Jira Due date. Compare calendar dates on the issue. The original timestamps are in the export. |
| Bucket and labels | Enable category mapping in a Jira Cloud business space and group the board by Category. Business labels stay in Labels. Jira workflow status is separate from the bucket. |
| Readiness Assessment, Complexity Score, Ticket # | Three editable short-text fields with those exact names. Nonempty source values fill empty destination fields. Conflicts are reported. |
| Card owners | An editable **Planner owners** People field allowing multiple users. The importer adds matched accounts and preserves existing members. A sole owner also fills an empty Assignee. A newly created shared card starts unassigned. Re-import preserves a primary chosen by the team. |
| Notes, references and history | Notes appear in the description. Attachment URLs become web links. Card history, schedule, progress, priority, source identifiers and conversation references can be included in the description by option. Their default is off. |
| Effort | Optional native estimates use total and remaining effort. Completed effort in Planner is an aggregate. The importer does not manufacture individual Jira worklogs from that aggregate. |

## Verify and resume

- Check the preview against the source card and checklist totals. Read back a dated task, a closed task, a card with populated custom fields, one sole-owner card and one shared card. On the board use **Group → Category** to check bucket placement.
- Keep the original export with stable plan, card and checklist IDs. Jira stores a hidden `plannerSource` property to find earlier imports, including issues renamed in Jira. If a create response is interrupted, check the destination for the issue before resuming. An ambiguous match requires reconciliation. Repeating a CSV wizard import can create duplicates.
- For an owner-only pass, build the toolkit, register the host with `npm run install:host`, reconnect the Jira tab and start **Local assistant → Create and edit**. Run the following from the toolkit checkout. Standard output is a JSON report and progress goes to standard error. Save reports beside the local export.

  ```sh
  npm run --silent planner:owners -- --project TEST --file /path/to/plan.json > /path/to/owner-report.json
  ```

- Review `unmatched` and `warnings` in that report. A Planner resource can have a different display name in Jira. Where the export supplies a work email, the importer looks for an exact email match among assignable project users. Resolve account identities and project access before repeating the owner pass. Access changes are a separate administrator action.
- Set the optional local display-name preference described in the README before building to send a manager last. The report's `owners` array gives the import order and `jiraOwners` gives the order returned by Jira. Jira can reorder a multi-person field after saving.
- If the bridge disconnects, reconnect the intended Jira tab and restart the bridge. The owner-only command updates issues matched by their source properties and is safe to rerun after checking a failed write.

## Where to continue development

| Change | Implementation |
| --- | --- |
| Browser export collections, field joins or history pagination | Companion repo's `plannerBrowserExport.js` |
| Accepted export shape and CSV conversion | `src/services/PlannerTransfer.ts` |
| Deduplication, native dates, statuses and categories | `src/services/PlannerJiraImport.ts` |
| Description defaults and custom fields | `src/services/PlannerDescription.ts` and `PlannerTaskFields.ts` |
| Owner matching, order and verification | `src/services/PlannerAssignee.ts` shared by the extension and `scripts/planner-owners.mjs` |
| Import controls and regression tests | `src/features/planner/PlannerPanel.tsx` and `e2e/extension.spec.ts` |

Run `npx playwright install chromium` and `npm test` after changing the import. The browser tests cover reruns, adoption of earlier imports, preserved Jira edits, shared ownership and unknown accounts. Run `npm run package` to create the unpackable extension ZIP in `dist/`. Use synthetic fixtures in Git. Keep tenant exports, membership reports and screenshots in the local handoff.

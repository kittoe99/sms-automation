# CRM tabbed workspace

The CRM uses one persistent shell with Workspace, Reports, Setup and Platform areas.
Each area's tools are tabs. Find a tool in the sidebar also searches all permitted
tools. Visibility follows the existing staff/operator/form permissions.

## Navigation and refresh

- A tab fetches its data on first opening. Returning restores its actual DOM nodes,
  listeners, filters, pagination, expanded details, scroll position and unsaved inputs.
- Website detail tabs also retain their panels and drafts. Their first opening may
  fetch the data needed for that section; revisiting does not repeat those reads.
- Browser Back/Forward and existing `?view=` bookmarks work within the same shell.
  Arrow keys, Home and End navigate the main tab strip.
- Refresh reloads the active tab. If its visible form has unsaved edits, confirm before
  discarding them. Live signals flag other tabs for refresh; they do not repeatedly
  replace the screen. The Inbox retains guarded live updates while not editing.
- Tab memory is only in this document. Reloading, signing out, changing the business
  workspace or re-entering authentication clears it. Save important drafts before
  those actions. A tab switch itself preserves drafts; it does not save them remotely.
- The API still checks access and revisions on every request. A retained tab is a
  previously loaded snapshot, not a guarantee that server data has not changed.

## Implementation and verification

`public/tabWorkspace.js` owns memory and the serialized render queue. The queue lets
an in-flight render finish before activating another tab. `public/app.js` owns the
shared shell, per-tab UI state and access-filtered navigation. `public/platform.js`
retains independent directory state and website panels. `dashboard-theme.css` uses
the E2 site's Plus Jakarta Sans/Geist Mono fonts, blue actions, paper surfaces and
thin borders. Public forms keep their existing stylesheet.

Use `npm test` and `npm run build:frontend`. For a synthetic staff preview, run
`$env:CRM_TAB_QA_LOG='1'; node test/fixtures/platform-preview.js` in PowerShell,
then open `http://127.0.0.1:4319/shell`. API reads are logged so tab revisits can be
checked for zero additional requests. `/mobile` shows a 390px viewport. These are
local sample records; this fixture does not verify production provider operations.

The static site builds the `deploy-crm` branch. No API deployment or database
migration is needed for this frontend change. See `PROJECT_RECORD.md` for actual
release status rather than treating this procedure as evidence of deployment.

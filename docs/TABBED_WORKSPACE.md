# CRM tabbed workspace

The paired E2 customer dashboard uses the same visual language and now retains
visited hash-tab panels, filter/page selections, website details and account drafts.
Its sidebar is the only section navigation and becomes a horizontal row on mobile;
the duplicate inner strip has been removed.
Its separate access/revision validation and account-wide Refresh policy remain
unchanged; see `../E2local-main/docs/dashboard-cache.md` from the CRM repository.

The CRM uses one persistent shell with six direct daily pages and expandable
AI assistants, Reports, Settings and Administration groups. Sibling tools use
local tabs. Find a page searches all permitted pages and former labels. Visibility follows the existing staff/operator/form permissions.

## Navigation and refresh

- Most tabs fetch on first opening. Returning restores their DOM nodes, listeners,
  filters, pagination, expanded details, scroll position and unsaved inputs. Voice
  Agents, Calls and Automation activity remount their controls from retained models
  or scoped filters. Voice drafts survive navigation; audio and transcript details
  close on every departure, including when the destination is already cached.
- Form editor tabs retain their actual panel elements and event handlers, including
  unsaved message text. Explicit Refresh checks visible and retained form drafts.
  Archive/restore/duplicate operations invalidate the affected workspace snapshots.
- Website detail tabs also retain their panels and drafts. Their first opening may
  fetch the data needed for that section; revisiting does not repeat those reads.
- Browser Back/Forward and existing `?view=` bookmarks work within the same shell.
  Arrow keys, Home and End navigate the local tab strips.
- Refresh reloads the active tab. If its visible form has unsaved edits, confirm before
  discarding them. Live signals flag other tabs for refresh; they do not repeatedly
  replace the screen. The Inbox retains guarded live updates while not editing.
- Unsaved DOM/draft memory is only in this document. A separate authorized list cache can survive reload for up to a minute; see [Workspace performance](WORKSPACE_PERFORMANCE.md). Reloading, signing out, changing the business
  workspace or re-entering authentication clears it. Save important drafts before
  those actions. A tab switch itself preserves drafts; it does not save them remotely.
- The API still checks access and revisions on every request. A retained tab is a
  previously loaded snapshot, not a guarantee that server data has not changed.

## Implementation and verification

`public/tabWorkspace.js` owns memory and the shell render queue. Navigation cancels
obsolete token/transport waits, response-body reads and lazy module waits before
the next shell render. Sidebar and sibling-tab buttons retain their DOM identity
through loading and selection changes; only search or access changes rebuild
the sidebar. Late navigation completions cannot update history or steal focus. `public/app.js` owns the shared shell,
per-tab UI state and access-filtered navigation. Each `public/platform.js` instance
owns a separate host and a `public/pageLifecycle.js` read scope. Leaving cancels its
reads without awaiting provider requests, uploads or writes from every other tab.
Late responses cannot paint a different tab or update its heading. Retained platform
editors keep their inputs; cancelled secondary reads or completed background writes
flag Refresh instead of automatically replacing a draft. Workspace/session reset
disposes the instance and prevents starting further steps with its old context.

Realtime subscriptions, token refresh, fallback polling and pending refresh timers
are retired together when changing business or leaving authentication. A fresh
subscription uses the selected business. Explicit business headers on staff requests
are preserved and bypass the selected-business response cache.

Switching active Clerk accounts also retires the prior workspace. Token and
response identity fences prevent a delayed old-account request from entering the
new account's cache. Business/profile, booking, setup and Voice drafts and selected
records are cleared together. Bootstrap runs outside the retired page-read scope.
Late profile/email/booking writes retain their original page/business owner and
cannot repaint or replace another workspace's draft after completion.

`dashboard-theme.css` uses
the E2 site's Plus Jakarta Sans/Geist Mono fonts, blue actions, paper surfaces and
thin borders. Public forms keep their existing stylesheet.

Use `npm test` and `npm run build:frontend`. For a synthetic staff preview, run
`$env:CRM_TAB_QA_LOG='1'; node test/fixtures/platform-preview.js` in PowerShell,
then open `http://127.0.0.1:4319/shell`. API reads are logged so tab revisits can be
checked for zero additional requests. `/mobile` shows a 390px viewport. These are
local sample records; this fixture does not verify production provider operations.

The static site builds the `deploy-crm` branch. See the project record for the shipped October 14 lifecycle and
navigation fixes. The website deployment panel now requires the paired E2
`GET /api/web-hosting/:siteId?page=1&pageSize=25` detail contract; deploy that E2
endpoint before the CRM frontend. The response contains `site` plus `page`,
`pageSize`, `total` and `totalPages`; publication status is independent of the
deployment page. The frontend lifecycle fixes have no schema change; the complete
hardening release also includes CRM queue/reporting and E2 hosting-index migrations.
See [release order](HARDENING_RELEASE.md) and [project record](../PROJECT_RECORD.md)
for prerequisites and actual release status.

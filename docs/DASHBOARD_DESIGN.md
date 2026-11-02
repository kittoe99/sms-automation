# CRM Dashboard design

The CRM adapts the E2 customer Dashboard's header, sidebar, typography, ink
selection, flat hairline cards and pill buttons. Feature layouts remain in
`public/styles.css`; the CRM shell and shared controls use
`public/dashboard-theme.css`. Public embeds retain their existing theme.

Choose a workspace area to reveal its permitted tools directly beneath it.
Find a tool searches across areas. Overview offers Inbox, Contacts, Bookings and
Forms / follow-up shortcuts, with message totals, SMS details and the form
directory. Mobile uses the navigation drawer and two-column shortcut cards.

The release changes presentation and navigation placement only. Existing
permissions, drafts, business selection, API contracts and sending controls
remain in effect. No migrations or paired E2 application deployment are needed.

Verification: frontend build and the 16 tests in dashboardTheme, tabWorkspace,
pagePerformance, formDirectory and smsConnectionSummary pass. The existing
dashboardFollowups test expects previously retired markup. Deployment evidence
belongs in the paired project records; a passing build alone is not a release.

## Shared loading states (released October 11)

CRM release `d507c4c` uses the Dashboard ring loader for startup, workspaces and inline
refresh, including reduced-motion support. Background tab preparation and scoped
browser caching are described in [Workspace performance](WORKSPACE_PERFORMANCE.md).

## November 2 alignment (local)

Matches E2 `app/dashboard/dashboard.module.css` as of E2 `770d7c9`: tokens
`--ink #173e4c`, `--border #d9e2e5`, `--card-line #c7d5d9`, `--button-line #b4c7cc`,
workspace `#f5f7f8`, paper inputs `#fbfdfd`. Selected sidebar items, workspace tabs,
Form Builder tabs and chips are solid ink; hover is `#edf2f3`. Cards, KPI strip and
support link use 1px hairlines with no shadows; primary buttons are ink, secondary
buttons white with a 1px outline. Scrollbars are hidden but scrolling is unchanged.
`e2-theme.css` keeps the blue brand tokens for sign-in and embeds; the dashboard
overrides them in `dashboard-theme.css`.

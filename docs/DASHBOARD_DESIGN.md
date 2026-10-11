# CRM Dashboard design

The CRM adapts the E2 customer Dashboard's header, sidebar, typography, blue
selection, white bordered cards and pill buttons. Feature layouts remain in
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

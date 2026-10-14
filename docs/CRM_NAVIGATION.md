# CRM navigation

The sidebar opens daily work directly: **Home**, **Inbox**, **Contacts**,
**Bookings**, **Follow-ups**, and **Forms**. Secondary tools live in expandable
**AI assistants**, **Reports**, **Settings**, and staff-only **Administration**.
**Find a page** searches permitted pages, including their former names. On mobile,
open Menu. Navigation retains drafts and browser Back/Forward; existing `?view=`
bookmarks remain valid. See [Tabbed workspace](TABBED_WORKSPACE.md).

| Page or group | Contents |
| --- | --- |
| Home | Current paused follow-ups, paused AI conversations, requests needing help, recent attention rows, shortcuts, message totals and SMS connection |
| Inbox | Messages, Calls, and staff-only Needs your help |
| Contacts | Contact directory and Unsubscribed from SMS |
| Follow-ups | Activity, Form follow-ups, Contact templates, Email |
| Forms | Compact directory; Edit form, Follow-ups and Submissions tabs |
| AI assistants | Text replies and Voice agents |
| Reports | Message history and Message delivery |
| Settings | Business information, Booking availability and SMS connection |
| Administration | Users, Businesses, Websites, Twilio accounts and Set up business |

Home workload counts are current totals; recent follow-ups use the displayed date
range. The paused AI card opens the broader attention list. A failed read displays
Unavailable, not zero. Needs your help shows open requests among the latest 100
handoffs returned by the existing CRM endpoint; it is not a complete historical
queue. Current permissions and API behavior are unchanged.

The business selector contains only authorized workspaces. An empty account
shows **No business workspace**, not a sample business or stale selection.
Global Users, Businesses, Websites and Twilio account directories require staff
access; business tools require their own grants. Forms-only users cannot read
SMS/submissions simply because they can edit a form.

Use **Forms → Follow-ups** or **Follow-ups → Form follow-ups** to configure,
publish and turn on a versioned sequence. Use **Follow-ups → Contact templates**
for reusable direct templates, **Contacts → Manage follow-ups** for a person's
runs, and **Follow-ups → Activity** for outcomes. Email keeps its separate workflow.
The retired fixed-group SMS menu is not the setup path.

**AI assistants → Text replies** controls the independent inbound agent.
**Review only — no replies sent** is shadow mode; **Automatic replies** is live
mode. Running a form test does not change the agent's mode or satisfy its release
gates. **Voice agents** opens the existing connected/draft library.

**Settings → Booking availability** configures operational booking capacity.
**Business information** contains the reviewed profile and knowledge sources.
Written business hours alone do not create availability. See [Business profile
form](BUSINESS_PROFILE_FORM.md), [booking availability](BOOKING_AVAILABILITY.md)
and [Customer Voice](CUSTOMER_VOICE.md).

The header logo returns to the CRM's retained workspace; forms-only accounts
return to their permitted Forms workspace. A missing control should be resolved
through intended permissions, not another person's identity. See the
[staff user guide](USER_GUIDE.md) for daily procedures.

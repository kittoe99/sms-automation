# CRM navigation

The sidebar opens **Home**, **SMS**, **Contacts**, **Bookings**, **Forms** and
**Email**. **Calls & voice**, **Settings** and staff-only **Administration** hold
the remaining tools. **Find a page** includes former labels and only permitted
pages. Mobile Menu, retained drafts, browser Back/Forward and existing `?view=`
bookmarks continue to work. See [Tabbed workspace](TABBED_WORKSPACE.md).

| SMS tab | Contents |
| --- | --- |
| Inbox | Customer conversations and staff-only Needs your help |
| Automations | Contact messages and Form messages; form message editors stay inside SMS |
| AI replies | One business reply mode and instructions for every inbound SMS source |
| Activity | Follow-up activity, Message history and Delivery |

Forms remains the place to design forms and read submissions. Calls & voice holds
Calls and Voice agents. Email remains separate. Settings contains Business
information, Booking availability and SMS connection. Administration contains
Users, Businesses, Websites, Twilio accounts and Set up business.

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

Use **Forms → Follow-ups** or **SMS → Automations → Form messages** to configure,
publish and turn on a versioned sequence. Use **SMS → Automations → Contact messages**
for reusable direct templates, **Contacts → Manage follow-ups** for a person's
runs, and **SMS → Activity → Follow-up activity** for outcomes. Email keeps its separate workflow.
The retired fixed-group SMS menu is not the setup path.

**SMS → AI replies** controls the business-wide inbound agent, including replies
to form and contact automations. It reads recent accepted SMS across conversation
groups for the same business/customer. Saving an enabled mode also enables
automation context and coordination. Continue form/contact enquiry messages wait
30 minutes after inbound or accepted AI messages even in Off/Review only mode.
Pause/Stop policies, staff takeover and appointment reminders retain their rules.
**AI replies on** is the business-wide on/off control. New settings default on; existing explicit Off choices remain off. Form and contact editors also have a checked-by-default **AI replies** opt-out. Historical shadow results remain readable, but there is no required shadow/pilot setup. Testing a form does not change the business setting. **Voice agents** opens the existing connected/draft library.

**Settings → Booking availability** configures operational booking capacity.
**Business information** contains the reviewed profile and knowledge sources.
Written business hours alone do not create availability. See [Business profile
form](BUSINESS_PROFILE_FORM.md), [booking availability](BOOKING_AVAILABILITY.md)
and [Customer Voice](CUSTOMER_VOICE.md).

The header logo returns to the CRM's retained workspace; forms-only accounts
return to their permitted Forms workspace. A missing control should be resolved
through intended permissions, not another person's identity. See the
[staff user guide](USER_GUIDE.md) for daily procedures.

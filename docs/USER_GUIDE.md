# Staff user guide

## Registration and service visibility

After an E2 customer completes onboarding, open their owner-linked record under **Businesses**. Extend the prefilled information and **Save reviewed profile**, then explicitly add/link services and **Set live** individually. Draft services remain hidden from the customer. **Hide from customer** reverses visibility; website publication and SMS activation are separate. Administrative setup requires an existing completed customer registration. See [Business lifecycle](BUSINESS_LIFECYCLE.md) for transfers, existing records and rollout. The owner-linked lifecycle was released October 1; see the dated project record for evidence.

Use the CRM to manage business conversations, automation, appointments and website enquiries. This guide follows the current sidebar labels. Available workspaces and actions depend on your permissions; a missing management control is not a reason to use another person's login.

## Sign in and choose a workspace

1. Open `https://crm.e2local.com` and choose Sign in, or Sign up for a new staff identity.
2. Use the CRM account. An E2 customer account with the same email is still a separate identity.
3. If you have no assigned access, an existing administrator must grant the intended role. Signup does not make you an administrator or business owner.
4. Select the business before opening contacts, conversations, forms or reports. Check the selected business before sending or editing settings.

Global **Users**, **Businesses** and **Websites** are staff management areas. Business workspaces contain daily work and setup. Form-only operators can have access to Forms without permission to read SMS or submissions. A suspended account loses authenticated access while its history and grants remain available for restoration.

## Navigation

Daily pages are directly available in the sidebar: **Home**, **Inbox**,
**Contacts**, **Bookings**, **Follow-ups**, and **Forms**. **Find a page** also
accepts former page names. On a narrow screen, open Menu.

Home puts paused follow-ups and requests needing help first. Inbox has Messages,
Calls and a staff-only Needs your help tab. Follow-ups groups Activity, Form
follow-ups, Contact templates and Email. Forms has Edit form, Follow-ups and
Submissions tabs. Optional repeat settings and Preview & test are expandable.

Open AI assistants for Text replies or Voice agents; Reports for Message history
or Message delivery; Settings for Business information, Booking availability or
SMS connection. Staff directories and Set up business are under Administration.
Existing permissions still apply. See [navigation](CRM_NAVIGATION.md) for the full
map and [project record](../PROJECT_RECORD.md) for release status. The October 14
simplification is local until separately released.

## Contacts and consent

Find the contact in **Contacts** and inspect its business, phone, source and opt-out state. Phone numbers should be international E.164 values such as `+13035550123`. Names/emails help locate records but are not proof of identity or consent.

Record opt-in only when the customer actually granted it and supply the evidence requested by the UI. Opt-out suppresses sending and cancels applicable queued/future work. Importing a record, owning a website or creating a booking does not grant marketing consent. SMS and email consent are separate; changing one does not change the other.

## Inbox and message history

1. Open **Inbox** and choose the intended conversation. A contact can have general and automation-group threads; check the group before replying.
2. Read recent messages and the latest customer request. Use AI pause/resume when taking over or returning the thread to configured automation.
3. Compose and submit a reply once. The CRM queues eligible outbound work; it cannot promise delivery at the moment you click Send.
4. Inspect **Message history** or **Message delivery** for later provider status and errors. A queued message is not delivered, and a submitted message can still fail.

Inbound messages can be reassigned to a group where the UI allows it. This changes conversation context; it is not an enrollment or consent grant. The current send path enforces marketing-purpose eligibility; the historical API-key transactional send example does not describe this UI.

If a message is marked for review because its submission outcome is unknown, ask an operator to reconcile it. Sending a replacement immediately can duplicate a message already accepted by the provider. See [operations](OPERATIONS.md#recovery-rules).

## SMS automations

Current SMS follow-ups use saved message templates attached to forms or directly
to contacts. The former four fixed SMS groups and AI-generated outbound drafts
are retired. The four-group email workflow is still supported separately.

1. Open **Forms**, create or choose a named contact, quote or appointment form,
   and save its fields. Multiple forms can use the same starter type.
2. In **Automation**, copy a preset or add messages, delays, repeats, sending
   hours and the Pause/Continue reply policy. Review personalized previews.
3. Save the draft, publish an immutable version, then enable it for future
   eligible submissions. Form collection and sequence activation are separate.
4. Use **Submissions** to inspect each run and pause, resume or stop it. Publishing
   does not enroll old submissions; historical enrollment is an explicit action.
5. Use **Run simulation** for a no-send preview. **Start real SMS test** contacts
   the confirmed recipient on the actual schedule and can incur charges.

Sequences support 1–50 ordered messages, each with 1–1,000 sends. Existing runs
retain their published version. Missing fields pause the run. Reply, STOP,
consent, sending windows and provider uncertainty still gate delivery. See
[Form automations](FORM_AUTOMATIONS.md) for scheduling and test details.

For follow-ups without a form, use **Contacts → Manage automations**. Publish a
reusable direct template, choose the contact, customize and preview it, then
explicitly resolve any overlapping runs before starting. Direct templates offer
Pause/Continue/Stop on reply. **Stop all enquiry follow-ups** also blocks future
form/direct enquiry enrollment; **Allow future follow-ups** restarts nothing.
Appointment reminders and AI have separate controls. See
[Direct contact automations](DIRECT_CONTACT_AUTOMATIONS.md).

**Follow-ups → Activity** shows accepted/delivered messages, responses and outcomes.
Tagging or linking an existing booking records attribution; it does not create a
booking or grant consent. Sequence resume and AI resume are separate actions;
neither overrides STOP. See [report definitions](AUTOMATION_ACTIVITY.md).

## Bookings and booking setup

**Bookings** displays operational appointments. Open an appointment to inspect its customer, time, status and source; use the supported cancellation action for the intended appointment. Cancellation affects reminder eligibility. Times and send windows follow the configured business time zone.

**Service availability** configures availability and the information needed for booking conversations. Shared voice/Inbound AI service rules require an explicit service, IANA time zone, resource pool, duration, capacity, lead time, weekly hours and exceptions. ZIP and variant are optional; market is a staff label. Rules start disabled. Review future unclassified appointments before enabling a rule; they can block voice availability and must not be ignored to manufacture capacity.

A public Booking form creates a submission and confirmed reminder intake. It does **not** automatically create an operational appointment in Bookings. E2 customer Bookings reads operational appointments separately from website Leads. Do not tell a customer an appointment is operationally scheduled solely because a form submission exists.

## Inbound AI and business knowledge

Use **Text replies** for revision-checked off/shadow/live mode, business
instructions, approved knowledge and the separate booking permission. The
recorded rollout has Opek in shadow; other businesses default off. Live mode
requires the operator's validation gate and reviewed schedules. Check current
settings rather than assuming a dated rollout statement is live state.

Shadow records proposals without sending AI replies, creating bookings or
performing agent mutations. The ordinary inbound webhook still records messages
and applies consent and sequence reply policies. In live mode, a manual staff
reply pauses the conversation until explicitly resumed. STOP, stale revisions,
new messages and disabled sending fence tools and final submission.

The agent uses verified inbound identity and explicit confirmation for new
bookings. Cancellation, rescheduling and requests for a person go to staff.
It does not restart paused follow-ups. See [Inbound AI](INBOUND_AI.md).

Use **Business context** to maintain reviewed services, areas, hours and business
facts. Enrichment and knowledge extraction create drafts: approve a version
before it becomes active knowledge. Uploads accept text PDF, DOCX, TXT and
Markdown up to 10 MiB. Shared **Service availability** controls operational
booking; written opening hours alone do not configure capacity.

## Email

1. Open **Email** and choose one of the four groups.
2. Enter its purpose, email prompt, business context, cadence and real business mailing address.
3. Confirm provider readiness before enabling it. Email settings start disabled and are independent of SMS schedules.
4. For a public form, also enable that form's email-consent option. The customer must explicitly choose the separate unchecked email box.
5. Inspect enrollments/jobs. Resolve an obsolete enrollment; retry a failed job only through the supported action, which enforces provider uncertainty rules.

Public forms need both the enabled email group and enabled form switch. Staff intake requires an email address and consent evidence. No historical records are automatically enrolled. Unsubscribe stops that business's marketing email to the address; provider bounce/complaint/suppression can block the shared sender across businesses. These actions do not change SMS consent.

Replies go to the configured mailbox and are not ingested into this CRM. See [email operations](EMAIL_AUTOMATIONS.md).

## Forms and website embeds

1. Open **Forms** and create or select a named form using the Contact, Quote Request or Booking starter.
2. Edit title, description, button label, enabled state and up to 20 ordered custom fields. Name, Phone, Email, consent and Booking appointment time are fixed fields.
3. Save and inspect the form. Its public ID stays stable; saved changes affect existing embeds. Disabling a form stops public configuration/submissions.
4. Copy the supplied iframe snippet. It includes automatic resize support with a fixed-height fallback.
5. For a website that needs E2 Leads, use **Websites → selected website → Leads** to create/select the website-specific form connection and obtain its snippet. A plain Forms snippet has no E2 website attribution.

Custom answers and field-label snapshots preserve historical readability. Editing a form or saved submission details does not restart the original automation. Contact/Quote forms can save without SMS opt-in. Website connections indicate intended attribution, not proof of the physical browser origin.

Use a controlled test submission only when its possible automation effects are intended. A successful public form test can create intake and send work. For no-send layout inspection use the synthetic demo or an intentionally disabled test workflow.

## Business setup and provider activation

After a customer completes E2 registration, an administrator reviews the owner-linked business profile and explicitly adds SMS or connects an existing sender. Registration alone queues no Twilio work. **Add SMS** initializes the provider and queues subaccount/Message Service provisioning; the existing-account connection workflow is described in [Twilio connections](TWILIO_CONNECTIONS.md). Sending activation remains separate.

Choose the intended sender type and number, review the provider/legal details, and explicitly confirm paid actions. Complete the applicable registration and readiness checks, then use the controlled activation canary before enabling sending. An uncertain provisioning result requires reconciliation, not another business or account creation. See [Twilio businesses](multi-tenant-twilio.md).

## Users, businesses and websites

1. In **Users**, locate the account and verify its issuer and onboarding state. Same-email customer and CRM accounts remain distinct.
2. In **Businesses**, select the intended business and explicitly assign owner/operator/viewer permissions. Global staff authority is separate from business ownership.
3. In **Websites**, select the site, assign its business, and review its current ownership. Do not infer ownership from a name or email.
4. In **Business Info**, save website-specific details. These differ from SMS business context and customer onboarding profiles.
5. Use **Deployments** (Assets on older releases) for website files and preview review, **Domain** for hosting configuration, and **Leads** for attributed submissions and form connections. E2 owns the underlying hosting API.
6. Review the intended preview before publishing. Verify the customer can see only the intended website/enquiries and separately granted operational bookings.

Ownership transfer removes previous owner customer access by default and changes enquiry history cutoffs; a permission edit alone preserves the cutoff. Retired connections keep historical attribution. A website cannot simply move businesses while retained connections reference the old business. Refresh before retrying a stale-revision conflict.

Suspending an owner denies authenticated access but does not itself stop public form intake or business automation. To stop sending, use the applicable automation/sending controls separately. Full permission and recovery procedures are in [staff CRM](STAFF_CRM.md); hosting details are in [E2 hosting](../../E2local-main/docs/web-hosting.md).

## Reports and support

Use Dashboard for a summary, Message history for individual events, Delivery report for delivery/worker failures, Opt-Outs for suppression, and Inbound calls for recorded voice activity. Empty queues and an old idle heartbeat do not alone establish an outage.

When reporting a problem, provide the selected business identifier, screen, time, visible error and relevant job/message ID to an authorized operator. Do not include passwords, session tokens, verification codes or unnecessary customer message content. Start diagnosis with [troubleshooting](OPERATIONS.md#common-problems).

## October 5 availability update

CRM Booking setup now supports multiple daily windows, structured exceptions and
slot previews. SMS booking is separately gated by Inbound AI mode, booking permission and validated availability; the recorded Opek rollout remains shadow-only. A separate restricted
voice bridge supports new-booking preparation/confirmation after phone verification
and a fresh caller confirmation. Activation defaults off. See
[Booking availability](BOOKING_AVAILABILITY.md) for contracts, migration order,
caller workflow and actual validation. Earlier legacy `opek` voice-bridge setup
instructions do not activate the new registered-business endpoint.

## Voice Agent

Open **Voice Agents** to manage connected agents or create a private draft. New drafts require external runtime/phone setup before publishing or customer release. Save configuration before publishing. The guided release panel checks owner, reviewed profile and connected/published agent, then offers **Enable customer Voice** or **Hide customer access**. Call audio and full transcripts expire after 90 days. Service-interest leads do not grant SMS consent. See [staff/runtime details](VOICE_CRM.md) and [guided release](CUSTOMER_VOICE.md).

## Faster tab loading

The CRM uses the E2 Dashboard loading ring and prepares other permitted tabs in
the background. Default lists are saved for up to a minute in the current browser
session, including across reloads after your access is verified. Refresh fetches
current data; saves and live changes invalidate cached lists. Drafts stay in place
when switching tabs. “Refresh for latest activity” indicates an older retained view.
Deployed October 11 as CRM `d507c4c`. See [Workspace performance](WORKSPACE_PERFORMANCE.md).

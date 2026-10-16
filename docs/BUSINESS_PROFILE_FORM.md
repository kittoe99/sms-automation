# Business Info

Open Settings → Business information, or Administration → Businesses → View
details. Both screens use one Business Info document (up to 20,000 characters).
Write or paste services, areas, hours, FAQs, policies, pricing, and any other
approved customer-facing facts. Pricing is optional.

Existing structured facts are assembled into the document when first opened;
nothing is saved automatically or silently shortened. The original structured
fields and unknown profile fields are retained for existing E2 contracts. Once a
reviewed document exists, inbound SMS AI uses it as the primary reference instead
of the legacy structured facts. Approved additional reference documents can
supplement it; the main document wins when facts conflict.

Business identity, timezone and contact details are in a collapsed section.
Keep these consistent with the document. They support account identity, local
scheduling and fallback contact details. Editing written hours does not configure
booking availability, and writing an instruction does not grant AI new tools.

Save draft retains working content without changing the AI's reviewed reference.
Save business info explicitly reviews the document through the existing staff
workflow. Both use the latest setup revision; conflicts retain unsaved input for
rereading. Ownership checks, review attribution and customer cache invalidation
remain authoritative. Saving does not release services or turn SMS AI on.

If a requested price is unsupported, AI offers an explicitly saved phone or
website for an accurate quote. It cannot invent a price/contact or reuse a rate
for a different service. With no contact available, it requests staff help.

CRM migration 20261016220003_unified_business_info extends the existing profile
validator; it changes no profiles or AI settings by itself. E2's canonical setup,
ownership, service visibility and cache contracts remain unchanged. Reconcile
both migration histories and apply only the new forward migration. Deployment
and authorized Opek activation are recorded separately in both project records.

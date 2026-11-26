# CRM billing (staff)

Customers subscribe from the E2 dashboard (E2 `docs/billing.md`). Staff manage those
subscriptions from **Businesses → View details**, in the **Billing** card above SMS
connection. Every CRM staff member can use it; there is no separate billing grant.

## What staff can do

- See the business's Stripe subscriptions (plan, monthly amount, status, renewal or end
  date) and its last 25 payments, read live from Stripe.
- **Refund** a successful payment, in full or in part (up to the amount not yet
  refunded), with a reason (requested by customer, duplicate, fraudulent) and an optional
  internal note. The browser sends a request id, so a repeated click reuses one Stripe
  idempotency key and cannot refund twice.
- **Cancel at period end**, **Keep subscription** (undo a scheduled cancellation), or
  **Cancel now**. Cancelling does not refund anything; refund a payment separately.
- **Open in Stripe** for anything else: plan changes, coupons, disputes, invoices.

The Businesses list shows each business's current plan and status.

Each action asks for confirmation. Stripe is called only after the database confirms
staff access, and every charge or subscription is fetched first and must belong to the
business's stored Stripe customer. Successful actions are written to `platform_audit` as
`billing_refund`, `billing_cancel_at_period_end`, `billing_resume` or `billing_cancel_now`
with the staff account, Stripe ids, amount and note. The stored subscription state is
updated by the E2 Stripe webhook, normally within seconds.

## Code

- `supabase/functions/crm-api/billing.js`: Stripe calls (REST, no SDK), ownership checks.
- Routes in `crm-api/handler.js`: `GET /platform/billing?tenantId=`,
  `POST /platform/billing/refund`, `POST /platform/billing/subscription`.
- `public/billingAdmin.js`: the Billing card and the list summary.
- Migration `20261125130000_crm_billing.sql`: `sms_private.platform_billing(u, action, p)`
  (`read`, `audit`), staff-only, granted to `sms_api`. It reads E2 billing tables at call
  time, so it needs E2 `customer_billing`. The list summary is E2-owned
  (E2 `20261125140000_billing_business_list.sql`).

## Setup

1. ~~Apply the two migrations.~~ Done November 25, 2026: E2 `billing_business_list`
   (`20261126032241`), then CRM `crm_billing` (`20261126032253`).
2. Set `STRIPE_SECRET_KEY` as a secret on the `crm-api` Edge function (a restricted live
   key needs read on Charges and Subscriptions, write on Refunds and Subscriptions), then
   redeploy `crm-api`.
3. Release the CRM frontend.

Without the key, the card says Stripe is not configured and nothing is sent to Stripe.

# CRM user access controls (staff)

**Users → View details → Access.** Every CRM staff member can use these on any user
(customer or CRM staff), except on themselves.

| Action | Effect | Reversible with |
| --- | --- | --- |
| Suspend access (reason required) | Account status `suspended`: no E2 dashboard, CRM or business access. The person stays signed in to Clerk but sees "account unavailable". | Restore access |
| Block sign-in (reason required) | Suspends the account and records who blocked it and why, then bans the Clerk user and revokes every active session. They cannot sign in. | Unblock and restore access |
| Sign out everywhere | Revokes every active Clerk session. They can sign in again unless suspended or blocked. | — |

Per-business access (enable/disable, role) is unchanged: **Edit access** on the user or
business page.

The card also shows live Clerk state per sign-in application (blocked in Clerk or not,
last sign-in, active sessions) and the last 25 access changes with who, when and why.
The Users list shows an Active / Suspended / Blocked badge and has an **Access** filter.

Rules (database, `sms_private.platform_action`):
- Staff only; you cannot suspend or block yourself; the last active administrator
  cannot be suspended or blocked.
- A blocked account cannot be restored with Restore access; use Unblock.
- Block: the database step runs first, so the account is suspended even if Clerk fails;
  the CRM then shows the Clerk error and the action can be retried.
- Unblock: Clerk unban runs first; if it fails the account stays blocked. If the
  database step then fails, the person can sign in but remains suspended.
- Clerk account syncs never change status, so a ban event cannot restore access.

## Code

- E2 migration `20261126010000_account_access_controls.sql`: `access_blocked_at/by` and
  `access_block_reason` on `dashboard_accounts`; actions `access_block`,
  `access_unblock`, `access_sign_out`, `access_identity`; reason on `status`; Users
  list `access` filter, `access`, `accessBlockedByName` and `accessHistory` fields.
- `supabase/functions/crm-api/account-access.js` and routes
  `GET /platform/account-access`, `POST /platform/account-access/block|unblock|sign-out`.
- `public/accountAccess.js` (card and badge), `public/platform.js` (list filter).

## Production setup

1. E2 `20261126010000_account_access_controls.sql` is live as `20261126043536`.
2. Supabase lists `E2_CLERK_SECRET_KEY`, `E2_CLERK_ISSUER`, and `CRM_CLERK_SECRET_KEY`.
   `crm-api` v77 is active. A signed-in staff check of the customer Clerk key is pending.
3. Render published the CRM frontend from `3340eb9`.

Without a Clerk key for an account's application, Suspend/Restore still work, Block still
suspends, and the card reports that Clerk is not configured.

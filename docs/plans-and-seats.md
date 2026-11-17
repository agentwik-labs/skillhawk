# Plans, seats and billing

Status: built 2026-11-13. 2026-11-17: Teams moved to inquiry; self-serve checkout is Pro only. A goldfish review (design, readiness, scope, codebase) found 12 problems; the fixes are folded in below.
Code: `src/plans.js` (price list, gates), `src/store.js` (seats, plan state, write guard), `src/billing.js` (Stripe), `src/server.js` (routes). Tests: `test/billing.test.js`.

## Price list (`src/plans.js` is the source; `web/app.js` PRICING is tested against it)

| Plan | Price | Seats | Server features |
|---|---|---|---|
| Free | $0 | local CLI | Every developer tool, on your machine. Hosted orgs on Free get public skills only. |
| Pro | $20 / month | 1 | Private vault: versions, diffs, rollback, publish checks, signed copies, audit log, lockfile |
| Team | $100 / month | 5 included, $20 per extra seat | Pro plus streaming over MCP. Marked copies, trace, evidence and offboarding work on every plan; the reason to be on Team is more than one person. |
| Enterprise | Custom | negotiated | Support for running it on your own servers, security review, SSO (roadmap) |

The price for an extra seat is $20. The owner set the base and Team prices but not this one, so it is open to change.

## Enforcement

- **Off by default.** It is on only with `serve --plans enforce` (or `SKILLYARD_PLANS=enforce`). This is passed into `createServer`, so a shell variable can't change the test suite. A self-hosted MIT server stays unlimited. `/api/health` reports `plans` and `billing`.
- **Seat.** A seat is one distinct member name holding an active member token. Rules:
  - Each name holds at most 3 tokens, so one name can't stand in for a whole team.
  - Service tokens (`--service`, admin-only) take no seat. `canRead` refuses them private skills on every route: get, bundle, files, diff, MCP and stream.
  - Revoking a member frees their seat.
  - Server-admin tokens hold no org and take no seat.
- **Seat check.** It lives inside `Store.createToken`, so the API, the CLI and seed all go through it. When the org is full you get 402 with "N of N seats".
- **Feature gates.** Private skills need Pro. `/mcp?stream=1` needs Team; MCP passes a 402 straight through instead of wrapping it in JSON-RPC. Revoke, token delete and holdings are **never** gated, so offboarding works on any plan or status.
- **Read-only state.** An org goes read-only when a pilot passes its `pilotEndsAt`, when it is canceled, or when it is past due beyond 7 days after `periodEnd`. In that state:
  - publish, rollback, visibility, delete, org settings and new tokens return 402;
  - pulls, MCP, revoke and checkout keep working;
  - nobody is ever revoked automatically. An org over its seat count only has new members blocked.

## State

- **Fields:** `org.plan`, `org.seats`, and `org.billing = { status: pilot|active|past_due|canceled, pilotEndsAt?, periodEnd?, provider?, customerId?, subscriptionId?, lastEventAt? }`.
- **New orgs and migration:** new orgs, and existing orgs with no plan (migrated once on load and saved), become a Team pilot with `seats = max(5, seats in use)` and **no end date**. The operator sets the end date, so no current user is cut off by the deploy.
- **Who sees plan state:** `GET /api/orgs/:org` shows plan, seats and billing only to the org admin and the operator.
- **Audit:** `plan.change`, `token.create`, `token.revoke`, `skill.visibility` and `skill.delete` go into the hash-chained audit log. Blocked seat attempts go only to the event log.

## Billing

- **Operator path (now):**
  - `skillyard org plan <org> --plan team --seats 7 --status active [--pilot-ends date]` calls `PATCH /api/orgs/:org/plan` with the server-admin token. With `--data`, it edits a stopped server's data dir.
  - `skillyard org billing <org>` shows the plan, seats used and purchased, the price, access and enforcement.
  - First customers can pay through a Stripe Payment Link, and the operator then sets their plan by hand.
- **Stripe path (once the owner creates the account):**
  - **Configuration:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_SEAT`. Without them, checkout returns 501.
  - **Checkout:** `POST /api/orgs/:org/billing/checkout {plan: 'pro'}` (org admin). Team and Enterprise return 400 ("talk to us"); the operator sets them up. It sets `client_reference_id` and `subscription_data.metadata.org`. Seats above five are a quantity of the seat price. It returns 409 if the org already has a live subscription; seat changes go through the operator for now.
  - **Webhook signature:** `POST /api/billing/webhook` reads the raw body and checks the signature (HMAC-SHA256, any `v1` may match, 5-minute tolerance). A bad signature returns 400.
  - **Webhook processing:**
    - Event ids already seen are skipped; up to 500 are kept.
    - The subscription is **re-fetched** for every handled event, and its current state is applied. Out-of-order or stale events therefore can't revive a canceled org.
    - The org is found from the subscription metadata, then the checkout reference, then the stored subscription id.
    - Event types we don't handle return 200.
  - **Customer portal:** `POST /api/orgs/:org/billing/portal` (org admin) returns a Stripe portal link to cancel, change card or see invoices.
  - **API version:** pinned to `2024-06-20`.
  - **Status mapping:**

    | Stripe status | Billing status |
    |---|---|
    | active, trialing | active |
    | past_due, unpaid | past_due |
    | canceled, incomplete_expired, paused | canceled |
    | incomplete | status left unchanged |

## Not built

Proration, taxes, an invoices UI, coupons, annual plans, and self-serve seat changes on an existing subscription.

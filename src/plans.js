// Plans, seats and feature gates: the single source of truth for prices (docs/plans-and-seats.md).
// The website copy (web/app.js PRICING) is checked against this file by test/plans.test.js.

export const PLAN_ORDER = ['free', 'pro', 'team', 'enterprise'];

export const PLANS = {
  free: { id: 'free', name: 'Free', monthlyUsd: 0, includedSeats: 1, extraSeatUsd: null, maxSeats: 1 },
  pro: { id: 'pro', name: 'Pro', monthlyUsd: 20, includedSeats: 1, extraSeatUsd: null, maxSeats: 1 },
  team: { id: 'team', name: 'Team', monthlyUsd: 100, includedSeats: 5, extraSeatUsd: 20, maxSeats: 500 },
  enterprise: { id: 'enterprise', name: 'Enterprise', monthlyUsd: null, includedSeats: null, extraSeatUsd: null, maxSeats: Infinity },
};

/**
 * Server-side features and the lowest plan that includes each. Local CLI commands are never gated, and neither is
 * anything that takes access away (revoke, token delete, holdings): offboarding works on every plan and status.
 */
export const FEATURES = {
  'private-skills': 'pro',
  stream: 'team',
};

export const PAST_DUE_GRACE_DAYS = 7;
export const BILLING_STATUSES = ['pilot', 'active', 'past_due', 'canceled'];

export const planAtLeast = (plan, min) => PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(min);

/** Monthly price for a plan and seat count, or null when the price is negotiated. */
export function monthlyPrice(planId, seats) {
  const p = PLANS[planId];
  if (!p || p.monthlyUsd === null) return null;
  const extra = Math.max(0, (seats ?? p.includedSeats) - p.includedSeats);
  return p.monthlyUsd + extra * (p.extraSeatUsd || 0);
}

export function enforcing(env = process.env) {
  return env.SKILLYARD_PLANS === 'enforce';
}

export const TOKENS_PER_MEMBER = 3;

/** The plan fields a new org starts with: a Team pilot with no end date until the operator sets one. */
export function pilotBilling(seatsInUse = 0) {
  return { plan: 'team', seats: Math.max(PLANS.team.includedSeats, seatsInUse), billing: { status: 'pilot' } };
}

/** Check an operator or checkout request against the price list. Returns the normalised {plan, seats}. */
export function validatePlan(plan, seats) {
  const p = PLANS[plan];
  if (!p) throw new Error(`plan must be one of ${PLAN_ORDER.join(', ')}`);
  const n = seats === undefined || seats === null ? (p.includedSeats ?? 1) : Number(seats);
  if (!Number.isInteger(n) || n < 1) throw new Error('seats must be a whole number of at least 1');
  if (n > p.maxSeats) throw new Error(`${p.name} has at most ${p.maxSeats} seat${p.maxSeats === 1 ? '' : 's'}`);
  if (p.includedSeats && n < p.includedSeats && plan === 'team') throw new Error(`Team starts at ${p.includedSeats} seats`);
  return { plan, seats: n };
}

/** 'full' or 'read-only' for an org's billing state at time `now`. */
export function accessLevel(org, now = Date.now()) {
  const b = org.billing || {};
  if (b.status === 'active') return 'full';
  if (b.status === 'pilot') return !b.pilotEndsAt || Date.parse(b.pilotEndsAt) > now ? 'full' : 'read-only';
  if (b.status === 'past_due') return b.periodEnd && Date.parse(b.periodEnd) + PAST_DUE_GRACE_DAYS * 864e5 > now ? 'full' : 'read-only';
  return 'read-only';
}

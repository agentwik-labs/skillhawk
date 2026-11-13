// Billing: Stripe Checkout + webhooks over plain REST (no SDK), plus the operator path when Stripe is not set up.
// docs/plans-and-seats.md. Nothing here runs until STRIPE_* env vars are set; without them checkout answers 501 and
// plans are set by the server admin (skillyard org plan).
import crypto from 'node:crypto';
import { HttpError } from './store.js';
import { PLANS, validatePlan } from './plans.js';

export const STRIPE_API = 'https://api.stripe.com/v1';
export const STRIPE_VERSION = '2024-06-20'; // pinned: subscription.current_period_end lives on the subscription here
const TOLERANCE_S = 300;
const SEEN_MAX = 500;

export function billingConfig(env = process.env) {
  const cfg = {
    key: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    prices: { pro: env.STRIPE_PRICE_PRO || '', team: env.STRIPE_PRICE_TEAM || '', seat: env.STRIPE_PRICE_SEAT || '' },
  };
  cfg.configured = !!(cfg.key && cfg.webhookSecret && cfg.prices.pro && cfg.prices.team && cfg.prices.seat);
  return cfg;
}

/** Stripe-Signature check: t=<unix>,v1=<hex>[,v1=...]; HMAC-SHA256 over `${t}.${rawBody}`; any v1 may match (key rotation). */
export function verifyStripeSignature(raw, header, secret, { now = Date.now() } = {}) {
  if (!secret) throw new HttpError(400, 'webhook secret not configured');
  const parts = String(header || '').split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v || '');
  if (!Number.isFinite(t) || !sigs.length) throw new HttpError(400, 'bad Stripe-Signature header');
  if (Math.abs(now / 1000 - t) > TOLERANCE_S) throw new HttpError(400, 'webhook timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const ok = sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  if (!ok) throw new HttpError(400, 'webhook signature does not match');
  return true;
}

/** Stripe subscription status -> our billing status. null = leave the current status alone (payment not finished). */
export const STATUS_MAP = {
  active: 'active', trialing: 'active',
  past_due: 'past_due', unpaid: 'past_due',
  canceled: 'canceled', incomplete_expired: 'canceled', paused: 'canceled',
  incomplete: null,
};

/** Read plan, seats, status and period end from a Stripe subscription object. */
export function subscriptionState(sub, prices) {
  const items = sub?.items?.data || [];
  const qty = (id) => items.filter((i) => i.price?.id === id).reduce((a, i) => a + (i.quantity || 0), 0);
  const plan = qty(prices.team) ? 'team' : qty(prices.pro) ? 'pro' : null;
  const seats = plan === 'team' ? PLANS.team.includedSeats + qty(prices.seat) : 1;
  const end = sub.current_period_end || items[0]?.current_period_end;
  return {
    org: sub.metadata?.org || null, plan, seats, status: STATUS_MAP[sub.status] ?? null,
    periodEnd: end ? new Date(end * 1000).toISOString() : undefined,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id, subscriptionId: sub.id,
  };
}

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') form(v, key, out);
    else if (v !== undefined) out.append(key, String(v));
  }
  return out;
}

export function stripeClient(cfg, fetchImpl = globalThis.fetch) {
  const call = async (method, p, body) => {
    const res = await fetchImpl(`${STRIPE_API}${p}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.key}`, 'Stripe-Version': STRIPE_VERSION, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? form(body).toString() : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `Stripe ${method} ${p}: ${json.error?.message || res.status}`);
    return json;
  };
  return {
    createCheckoutSession: (params) => call('POST', '/checkout/sessions', params),
    getSubscription: (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`),
  };
}

/** Start a Stripe Checkout for an org. Seats beyond Team's five are a quantity of the seat price. */
export async function createCheckout(store, slug, { plan, seats }, { cfg = billingConfig(), client, baseUrl }) {
  const org = store.getOrg(slug);
  if (!org) throw new HttpError(404, `org ${slug} not found`);
  if (!cfg.configured) throw new HttpError(501, 'billing is not configured on this server; plans are set by the operator during the pilot');
  if (plan === 'enterprise' || plan === 'free') throw new HttpError(400, `${plan} has no checkout; talk to us`);
  let want;
  try { want = validatePlan(plan, seats); } catch (e) { throw new HttpError(400, e.message); }
  if (org.billing?.subscriptionId && org.billing?.status !== 'canceled') throw new HttpError(409, 'this org already has a subscription; seat changes go through the operator for now');
  const extra = want.plan === 'team' ? want.seats - PLANS.team.includedSeats : 0;
  const line_items = { 0: { price: cfg.prices[want.plan], quantity: 1 }, ...(extra > 0 ? { 1: { price: cfg.prices.seat, quantity: extra } } : {}) };
  const s = await (client || stripeClient(cfg)).createCheckoutSession({
    mode: 'subscription', client_reference_id: slug, line_items,
    subscription_data: { metadata: { org: slug } }, metadata: { org: slug },
    success_url: `${baseUrl}/#/teams?billing=ok`, cancel_url: `${baseUrl}/#/teams?billing=cancel`,
  });
  return { url: s.url, plan: want.plan, seats: want.seats };
}

/**
 * Apply a verified Stripe event. Events can repeat and arrive out of order, so: skip ids already seen, and re-fetch
 * the subscription and apply its current state rather than trusting the event body.
 */
export async function handleStripeEvent(store, event, { cfg = billingConfig(), client } = {}) {
  store.db.billingEvents ||= [];
  if (store.db.billingEvents.includes(event.id)) return { ignored: 'duplicate' };
  const obj = event.data?.object || {};
  let subId = null;
  let orgHint = null;
  if (event.type === 'checkout.session.completed') { subId = obj.subscription; orgHint = obj.client_reference_id || obj.metadata?.org; }
  else if (event.type?.startsWith('customer.subscription.')) subId = obj.id;
  else if (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid') subId = obj.subscription;
  else return { ignored: event.type };
  if (!subId) return { ignored: 'no subscription' };

  const sub = await (client || stripeClient(cfg)).getSubscription(typeof subId === 'string' ? subId : subId.id);
  const st = subscriptionState(sub, cfg.prices);
  const slug = [st.org, orgHint].find((s) => s && store.getOrg(s))
    || Object.values(store.db.orgs).find((o) => o.billing?.subscriptionId === st.subscriptionId)?.slug;
  store.db.billingEvents.push(event.id);
  if (store.db.billingEvents.length > SEEN_MAX) store.db.billingEvents.splice(0, store.db.billingEvents.length - SEEN_MAX);
  if (!slug) { store.log('billing.unmatched', { event: event.id, subscription: st.subscriptionId }); store.save(); return { ignored: 'unknown org' }; }
  const patch = { provider: 'stripe', customerId: st.customerId, subscriptionId: st.subscriptionId, periodEnd: st.periodEnd, lastEventAt: new Date((event.created || 0) * 1000).toISOString() };
  if (st.status) patch.status = st.status;
  if (st.plan) { patch.plan = st.plan; patch.seats = st.seats; }
  return { applied: store.setPlan(slug, patch, { name: 'stripe' }) };
}

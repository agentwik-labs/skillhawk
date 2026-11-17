// File-backed registry store: orgs, API tokens, skills and their immutable versions.
// Metadata lives in <dataDir>/db.json (written atomically); file contents in <dataDir>/blobs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanFiles } from './scan.js';
import { accessLevel, BILLING_STATUSES, FEATURES, monthlyPrice, pilotBilling, planAtLeast, PLANS, TOKENS_PER_MEMBER, validatePlan } from './plans.js';
import { diffFiles, GRADES, newOrgKeys, roleOf, ROLE_SCOPES, ROLES, runChecks } from './vault.js';
import { checksum, compareSemver, resolveVersion, safeRelPath, SCOPE_RE, skillId, validateFiles } from './skill.js';

const EMPTY_DB = () => ({ version: 1, orgs: {}, tokens: {}, skills: {}, events: [], marks: [], beacons: {}, alerts: [] });
export const SCOPES = ['read', 'publish', 'admin'];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Store {
  /** plans: 'enforce' turns on seat limits, feature gates and read-only billing states (hosted vault); default off. */
  constructor(dataDir, { plans = 'off' } = {}) {
    this.enforce = plans === 'enforce';
    this.dataDir = path.resolve(dataDir);
    this.dbPath = path.join(this.dataDir, 'db.json');
    this.blobDir = path.join(this.dataDir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.db = fs.existsSync(this.dbPath) ? JSON.parse(fs.readFileSync(this.dbPath, 'utf8')) : EMPTY_DB();
    this.db.marks ||= [];
    this.db.beacons ||= {};
    this.db.alerts ||= [];
    this.auditPath = path.join(this.dataDir, 'audit.jsonl');
    // Orgs from before plans existed become a Team pilot sized to the members they already have; saved once.
    const legacy = Object.values(this.db.orgs).filter((o) => o.plan === undefined);
    for (const o of legacy) Object.assign(o, pilotBilling(this.seatsUsed(o.slug)));
    if (legacy.length && fs.existsSync(this.dbPath)) this.save();
  }

  // ---- plans and seats (docs/plans-and-seats.md) ----------------------------

  /** Active tokens that hold a seat: org tokens that are not revoked and not service tokens. */
  memberTokens(org) {
    return Object.values(this.db.tokens).filter((t) => t.org === org && !t.revoked && t.kind !== 'service');
  }

  /** A seat is one distinct member name with at least one active member token. */
  seatsUsed(org) {
    return new Set(this.memberTokens(org).map((t) => t.name)).size;
  }

  billingState(slug) {
    const o = this.db.orgs[slug];
    if (!o) throw new HttpError(404, `org ${slug} not found`);
    const b = o.billing || {};
    return {
      org: slug, plan: o.plan, planName: PLANS[o.plan]?.name || o.plan, seats: o.seats, seatsUsed: this.seatsUsed(slug),
      status: b.status || null, pilotEndsAt: b.pilotEndsAt || null, periodEnd: b.periodEnd || null,
      monthlyUsd: monthlyPrice(o.plan, o.seats), access: accessLevel(o), enforcement: this.enforce ? 'enforce' : 'off',
      subscription: b.subscriptionId ? { provider: b.provider || null, id: b.subscriptionId } : null,
    };
  }

  /** Under enforcement, a read-only org (ended pilot, canceled, past due beyond grace) keeps pulls but loses writes. */
  assertWritable(slug) {
    const o = this.db.orgs[slug];
    if (!this.enforce || !o || accessLevel(o) === 'full') return;
    const why = o.billing?.status === 'pilot' ? 'the pilot has ended' : `billing is ${o.billing?.status || 'not set up'}`;
    throw new HttpError(402, `@${slug} is read-only because ${why}. Pulls and revokes still work. See: skillyard org billing ${slug}`);
  }

  assertFeature(slug, feature) {
    if (!this.enforce || !this.db.orgs[slug]) return;
    const plan = this.db.orgs[slug].plan || 'free';
    const min = FEATURES[feature];
    if (!planAtLeast(plan, min)) throw new HttpError(402, `${feature} needs the ${PLANS[min].name} plan or higher; @${slug} is on ${PLANS[plan]?.name || plan}`);
  }

  /**
   * Set an org's plan, seats and billing fields. Callers: the server admin (operator, PATCH /api/orgs/:org/plan) and
   * the billing webhook. Seats below the number in use are allowed; nobody is revoked, new members are just blocked.
   */
  setPlan(slug, { plan, seats, status, pilotEndsAt, periodEnd, provider, customerId, subscriptionId, lastEventAt } = {}, auth) {
    const o = this.db.orgs[slug];
    if (!o) throw new HttpError(404, `org ${slug} not found`);
    let next;
    try {
      next = validatePlan(plan ?? o.plan, seats ?? (plan && plan !== o.plan ? undefined : o.seats));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (status !== undefined && !BILLING_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${BILLING_STATUSES.join(', ')}`);
    for (const [k, v] of Object.entries({ pilotEndsAt, periodEnd })) {
      if (v !== undefined && v !== null && Number.isNaN(Date.parse(v))) throw new HttpError(400, `${k} must be an ISO date`);
    }
    const before = { plan: o.plan, seats: o.seats, status: o.billing?.status || null };
    o.plan = next.plan;
    o.seats = next.seats;
    o.billing = { ...(o.billing || {}) };
    const fields = { status, pilotEndsAt, periodEnd, provider, customerId, subscriptionId, lastEventAt };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) { if (v === null) delete o.billing[k]; else o.billing[k] = v; }
    this.save();
    this.audit({ action: 'plan.change', org: slug, before, after: { plan: o.plan, seats: o.seats, status: o.billing.status || null } }, auth);
    return this.billingState(slug);
  }

  /**
   * Append-only audit log (JSON lines, never rewritten), hash-chained: each entry stores prev (the hash of the entry
   * before it, or "genesis") and hash = sha256(prev + canonical entry). who = token name, host = client hostname.
   */
  audit(entry, auth) {
    const rec = { at: new Date().toISOString(), who: auth?.name || auth?.tokenId || 'anonymous', tokenId: auth?.tokenId || null, host: auth?.host || null, ...entry };
    rec.prev = this.auditTip();
    rec.hash = auditHash(rec);
    fs.appendFileSync(this.auditPath, `${JSON.stringify(rec)}\n`);
    return rec;
  }

  /** Hash the next entry must chain to: the last entry's hash, the sha256 of a legacy last line, or "genesis". */
  auditTip() {
    if (!fs.existsSync(this.auditPath)) return 'genesis';
    const lines = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter(Boolean);
    if (!lines.length) return 'genesis';
    const last = lines[lines.length - 1];
    try { const e = JSON.parse(last); if (e.hash) return e.hash; } catch { /* fall through to raw hash */ }
    return crypto.createHash('sha256').update(last).digest('hex');
  }

  /** Walk audit.jsonl and check the chain. Entries written before chaining existed count as legacy. */
  verifyAudit() {
    return verifyAuditFile(this.auditPath);
  }

  /** Org-level setting for the optional beacon mark layer. Enabling needs an explicit legal-review acknowledgement. */
  setBeacon(slug, on, legalReview, auth) {
    const org = this.db.orgs[slug];
    if (!org) throw new HttpError(404, `org ${slug} not found`);
    if (on && !legalReview) throw new HttpError(400, 'enabling the beacon needs --i-have-legal-review (read docs/beacon.md first)');
    org.beacon = { enabled: !!on, changedAt: new Date().toISOString(), legalReviewAcknowledged: !!on && !!legalReview };
    this.audit({ action: on ? 'beacon.enable' : 'beacon.disable', org: slug, legalReviewAcknowledged: !!legalReview }, auth || { name: 'cli' });
    this.save();
    return this.publicOrg(org);
  }

  /** Stable opaque token for (org, recipient, skill, version), remembered server-side. */
  registerBeacon({ org, recipient, skill, version, token }) {
    this.db.beacons[token] ||= { org, recipient, skill, version, createdAt: new Date().toISOString() };
    this.save();
  }

  /** Record a beacon fetch. Returns the alert, or null for an unknown token. Collects only time, ip, user-agent, referer. */
  recordBeaconHit(token, { ip, userAgent, referer }) {
    const b = this.db.beacons[token];
    if (!b) return null;
    const alert = { at: new Date().toISOString(), org: b.org, recipient: b.recipient, skill: b.skill, version: b.version, token, ip: ip || null, userAgent: String(userAgent || '').slice(0, 300) || null, referer: String(referer || '').slice(0, 300) || null };
    this.db.alerts.push(alert);
    if (this.db.alerts.length > 5000) this.db.alerts.splice(0, this.db.alerts.length - 5000);
    this.audit({ action: 'beacon.hit', org: b.org, skill: b.skill, version: b.version, recipient: b.recipient }, { name: 'beacon' });
    this.save();
    return alert;
  }

  alerts(org) {
    return this.db.alerts.filter((a) => !org || a.org === org);
  }

  auditLog({ org, skill, limit = 500 } = {}) {
    if (!fs.existsSync(this.auditPath)) return [];
    const all = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return all.filter((e) => (!org || e.org === org) && (!skill || e.skill === skill || e.skill === `@${org || e.org}/${skill}`)).slice(-limit).reverse();
  }

  recordMark({ recipient, skill, version, fingerprint }) {
    this.db.marks.push({ recipient, skill, version, fingerprint, at: new Date().toISOString() });
    this.save();
  }

  isOrgAdmin(auth, scope) {
    return !!auth?.admin || (auth?.org === scope && auth.role === 'admin');
  }

  /** Org record without its secret and private key. */
  publicOrg(o) {
    if (!o) return o;
    const { secret, privateKey, ...rest } = o;
    return rest;
  }

  save() {
    const tmp = `${this.dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.dbPath);
  }

  log(type, detail) {
    this.db.events.push({ at: new Date().toISOString(), type, ...detail });
    if (this.db.events.length > 1000) this.db.events.splice(0, this.db.events.length - 1000);
  }

  // ---- orgs ---------------------------------------------------------------

  createOrg({ slug, name, description = '', website = '', minGrade = 'C' }) {
    if (!GRADES.includes(minGrade)) throw new HttpError(400, `minGrade must be one of ${GRADES.join(', ')}`);
    if (!SCOPE_RE.test(slug || '') || slug.length > 40) throw new HttpError(400, 'org slug must be lowercase-hyphenated, <= 40 chars');
    if (this.db.orgs[slug]) throw new HttpError(409, `org ${slug} already exists`);
    const org = { slug, name: name || slug, description, website, createdAt: new Date().toISOString(), minGrade, ...pilotBilling(), ...newOrgKeys() };
    this.db.orgs[slug] = org;
    this.log('org.create', { org: slug });
    this.save();
    return this.publicOrg(org);
  }

  setMinGrade(slug, minGrade) {
    if (!GRADES.includes(minGrade)) throw new HttpError(400, `minGrade must be one of ${GRADES.join(', ')}`);
    this.assertWritable(slug);
    this.db.orgs[slug].minGrade = minGrade;
    this.save();
    return this.publicOrg(this.db.orgs[slug]);
  }

  getOrg(slug) {
    return this.db.orgs[slug] || null;
  }

  listOrgs(auth) {
    return Object.values(this.db.orgs).map((o) => {
      const skills = Object.values(this.db.skills).filter((s) => s.scope === o.slug);
      const visible = skills.filter((s) => this.canRead(s, auth));
      return { ...this.publicOrg(o), skillCount: visible.length, privateCount: visible.filter((s) => s.visibility === 'private').length };
    }).filter((o) => o.skillCount > 0 || auth?.org === o.slug || auth?.admin);
  }

  // ---- tokens -------------------------------------------------------------

  createToken({ org, name = 'token', scopes = ['read'], role, kind = 'member' }, auth) {
    if (!['member', 'service'].includes(kind)) throw new HttpError(400, 'kind must be member or service');
    if (role) {
      if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
      if (!org) throw new HttpError(400, 'roles apply to org tokens');
      scopes = ROLE_SCOPES[role];
    }
    if (org && !this.db.orgs[org]) throw new HttpError(404, `org ${org} not found`);
    const bad = scopes.filter((s) => !SCOPES.includes(s));
    if (bad.length) throw new HttpError(400, `unknown scopes: ${bad.join(', ')}`);
    if (scopes.includes('admin') && org) throw new HttpError(400, 'admin tokens are not tied to an org');
    if (kind === 'service' && !org) throw new HttpError(400, 'service tokens belong to an org');
    if (org && this.enforce) {
      this.assertWritable(org);
      if (kind === 'member') {
        const mine = this.memberTokens(org).filter((t) => t.name === name).length;
        if (mine >= TOKENS_PER_MEMBER) throw new HttpError(409, `${name} already has ${mine} active tokens (limit ${TOKENS_PER_MEMBER}); revoke one first`);
        const used = this.seatsUsed(org);
        const o = this.db.orgs[org];
        if (!mine && used >= o.seats) {
          this.log('seat.blocked', { org, member: name, used, seats: o.seats });
          throw new HttpError(402, `seat limit reached: ${used} of ${o.seats} seats on ${PLANS[o.plan]?.name || o.plan}. Revoke a member (skillyard revoke) or add seats (skillyard org billing ${org})`);
        }
      }
    }
    const secret = `sy_${crypto.randomBytes(24).toString('base64url')}`;
    const id = crypto.randomBytes(6).toString('hex');
    this.db.tokens[id] = { id, org: org || null, name, scopes, role: role || (scopes.includes('publish') ? 'editor' : scopes.includes('admin') ? 'admin' : 'reader'), ...(kind === 'service' ? { kind } : {}), hash: hashToken(secret), createdAt: new Date().toISOString(), lastUsedAt: null };
    this.log('token.create', { org, tokenId: id, scopes, role });
    this.save();
    if (org) this.audit({ action: 'token.create', org, tokenId: id, member: name, kind, scopes }, auth);
    return { id, token: secret, org: org || null, name, scopes, kind, role: this.db.tokens[id].role };
  }

  listTokens(org) {
    return Object.values(this.db.tokens).filter((t) => t.org === org).map(({ hash, ...t }) => t);
  }

  revokeToken(id, org) {
    const t = this.db.tokens[id];
    if (!t || (org !== undefined && t.org !== org)) throw new HttpError(404, 'token not found');
    delete this.db.tokens[id];
    this.log('token.revoke', { org: t.org, tokenId: id });
    if (t.org) this.audit({ action: 'token.revoke', org: t.org, tokenId: id, member: t.name }, null);
    this.save();
  }

  /** Disable every token of a member (matched by token name or id) at once. Records stay so later calls get a clear error. */
  revokeMember(org, member, auth) {
    const hits = Object.values(this.db.tokens).filter((t) => t.org === org && (t.name === member || t.id === member));
    if (!hits.length) throw new HttpError(404, `no member or token "${member}" in @${org}`);
    const at = new Date().toISOString();
    for (const t of hits) t.revoked ||= { at, by: auth?.name || 'admin' };
    this.log('member.revoke', { org, member });
    this.save();
    this.audit({ action: 'member.revoke', org, member, tokenIds: hits.map((t) => t.id) }, auth);
    return { member, org, revoked: hits.map((t) => t.id) };
  }

  setLeaseDays(slug, days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'leaseDays must be a whole number from 1 to 365');
    this.assertWritable(slug);
    this.db.orgs[slug].leaseDays = n;
    this.save();
    return this.publicOrg(this.db.orgs[slug]);
  }

  /** Everything a member pulled (installed or streamed): one row per skill version, from the audit log and the marks. */
  holdings(org, member) {
    const names = new Set([member]);
    for (const t of Object.values(this.db.tokens)) if (t.org === org && t.id === member) names.add(t.name);
    const rows = new Map();
    const row = (skill, version) => {
      const k = `${skill}@${version}`;
      if (!rows.has(k)) rows.set(k, { skill, version, count: 0, first: null, last: null, via: new Set(), fingerprint: null });
      return rows.get(k);
    };
    for (const e of this.auditLog({ org, limit: 100000 }).reverse()) {
      if (!names.has(e.who) || !['pull', 'stream.load'].includes(e.action) || !e.skill) continue;
      const r = row(e.skill, e.version);
      r.count++;
      r.first ||= e.at;
      r.last = e.at;
      r.via.add(e.action === 'stream.load' ? 'stream' : 'install');
    }
    for (const m of this.db.marks) {
      if (!names.has(m.recipient) || !m.skill.startsWith(`@${org}/`)) continue;
      const r = row(m.skill, m.version);
      r.fingerprint = m.fingerprint || r.fingerprint;
      r.first ||= m.at;
      r.last = r.last && r.last > m.at ? r.last : m.at;
    }
    const tokens = Object.values(this.db.tokens).filter((t) => t.org === org && names.has(t.name)).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, revokedAt: t.revoked?.at || null }));
    return { member, org, tokens, held: [...rows.values()].map((r) => ({ ...r, via: [...r.via] })).sort((a, b) => a.skill.localeCompare(b.skill) || a.version.localeCompare(b.version)) };
  }

  /** Bearer token -> auth context, or null for anonymous. Throws 401 on an unknown token. */
  authenticate(secret, adminToken) {
    if (!secret) return null;
    if (adminToken && timingSafeEqual(secret, adminToken)) return { admin: true, org: null, scopes: SCOPES, role: 'admin', name: 'admin', tokenId: 'env' };
    const h = hashToken(secret);
    const t = Object.values(this.db.tokens).find((x) => timingSafeEqual(x.hash, h));
    if (!t) throw new HttpError(401, 'invalid token');
    if (t.revoked) {
      this.audit({ action: 'access.denied', org: t.org, reason: 'token revoked' }, { name: t.name, tokenId: t.id });
      throw new HttpError(401, 'access revoked by your org admin');
    }
    const today = new Date().toISOString().slice(0, 10);
    if (!t.lastUsedAt || !t.lastUsedAt.startsWith(today)) {
      t.lastUsedAt = new Date().toISOString();
      this.save();
    }
    return { admin: t.scopes.includes('admin'), org: t.org, scopes: t.scopes, role: roleOf(t), name: t.name, tokenId: t.id, kind: t.kind || 'member' };
  }

  // ---- access -------------------------------------------------------------

  canRead(skill, auth) {
    if (skill.visibility === 'public' || auth?.admin) return true;
    // Service tokens (CI, bots) take no seat, so they never receive private content: a copy must be marked for a person.
    return auth?.org === skill.scope && auth.scopes.includes('read') && auth.kind !== 'service';
  }

  canPublish(scope, auth) {
    return !!auth?.admin || (auth?.org === scope && auth.scopes.includes('publish'));
  }

  // ---- skills -------------------------------------------------------------

  /**
   * Publish a new immutable version. files: {relPath: Buffer}.
   * Visibility comes from the request, then skill.json, then the existing record, then "private" for org scopes.
   */
  publish({ scope, files, visibility, auth, publishedBy, force = false, signature = null }) {
    if (!this.db.orgs[scope]) throw new HttpError(404, `org ${scope} not found`);
    if (!publishedBy) this.assertWritable(scope);
    if (!this.canPublish(scope, auth)) throw new HttpError(403, `token cannot publish to @${scope}`);
    const v = validateFiles(files);
    if (!v.ok) throw new HttpError(422, `invalid skill: ${v.errors.join('; ')}`);
    const { manifest } = v;
    const scan = scanFiles(files);
    if (scan.critical) {
      const top = scan.findings.filter((f) => f.severity === 'critical').slice(0, 5).map((f) => `${f.file}:${f.line} ${f.message}`);
      throw new HttpError(422, `security scan blocked publish: ${top.join('; ')}`);
    }
    const id = skillId(scope, manifest.name);
    // Org checks: Reviewer + Security must pass. Internal callers (seed, import) pass publishedBy and skip them.
    let check = null;
    if (!publishedBy) {
      const c = runChecks(files, this.db.orgs[scope].minGrade || 'C');
      check = { ...c.summary, minGrade: c.minGrade, passed: c.passed, forced: false };
      if (!c.passed) {
        const forced = force && this.isOrgAdmin(auth, scope);
        this.audit({ action: forced ? 'publish.forced' : 'publish.rejected', org: scope, skill: id, version: manifest.version, check, reasons: c.reasons }, auth);
        if (!forced) {
          if (force) throw new HttpError(403, `only an org admin can force a failing publish\n${c.reasons.join('; ')}\n${c.report}`);
          throw new HttpError(422, `publish checks failed: ${c.reasons.join('; ')}\n${c.report}\n(an org admin can override with --force; it is logged)`);
        }
        check.forced = true;
      }
    }
    const existing = this.db.skills[id];
    if (existing?.versions[manifest.version]) throw new HttpError(409, `${id}@${manifest.version} already exists; bump the version in skill.json`);
    const vis = visibility || manifest.visibility || existing?.visibility || 'private';
    if (!['public', 'private'].includes(vis)) throw new HttpError(400, 'visibility must be public or private');
    if (vis === 'private' && !publishedBy) this.assertFeature(scope, 'private-skills');

    const dir = this.versionDir(scope, manifest.name, manifest.version);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, buf] of Object.entries(files)) {
      const safe = safeRelPath(rel);
      const dest = path.join(dir, safe);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    const now = new Date().toISOString();
    const rec = existing || { id, scope, name: manifest.name, createdAt: now, downloads: 0, versions: {} };
    rec.visibility = vis;
    rec.updatedAt = now;
    rec.versions[manifest.version] = {
      manifest,
      checksum: checksum(files),
      size: Object.values(files).reduce((a, b) => a + b.length, 0),
      files: Object.keys(files).sort(),
      publishedAt: now,
      publishedBy: publishedBy || auth?.tokenId || null,
      scan: { scannedAt: now, critical: 0, warning: scan.warning, findings: scan.findings },
      signature: signature || undefined,
    };
    rec.latest = resolveVersion(Object.keys(rec.versions), 'latest');
    this.db.skills[id] = rec;
    this.audit({ action: 'publish', org: scope, skill: id, version: manifest.version, check, forced: !!check?.forced }, auth);
    this.log('skill.publish', { skill: id, version: manifest.version, visibility: vis, by: rec.versions[manifest.version].publishedBy });
    this.save();
    return { ...this.summary(rec), warnings: [...v.warnings, ...scan.findings.map((f) => `security: ${f.file}:${f.line} ${f.message}`)] };
  }

  setVisibility(scope, name, visibility, auth) {
    const rec = this.db.skills[skillId(scope, name)];
    if (!rec) throw new HttpError(404, 'skill not found');
    if (!this.canPublish(scope, auth)) throw new HttpError(403, 'forbidden');
    if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'visibility must be public or private');
    this.assertWritable(scope);
    if (visibility === 'private') this.assertFeature(scope, 'private-skills');
    rec.visibility = visibility;
    this.audit({ action: 'skill.visibility', org: scope, skill: rec.id, visibility }, auth);
    this.log('skill.visibility', { skill: rec.id, visibility });
    this.save();
    return this.summary(rec);
  }

  deleteSkill(scope, name, auth) {
    const rec = this.db.skills[skillId(scope, name)];
    if (!rec) throw new HttpError(404, 'skill not found');
    if (!this.canPublish(scope, auth)) throw new HttpError(403, 'forbidden');
    // No assertWritable: a canceled or lapsed customer can always delete their own data.
    this.audit({ action: 'skill.delete', org: scope, skill: rec.id }, auth);
    delete this.db.skills[rec.id];
    fs.rmSync(path.join(this.blobDir, scope, name), { recursive: true, force: true });
    this.log('skill.delete', { skill: rec.id });
    this.save();
  }

  versionDir(scope, name, version) {
    return path.join(this.blobDir, scope, name, version);
  }

  /** Look up a readable skill. Private skills the caller cannot read are reported as missing. */
  find(scope, name, auth) {
    const rec = this.db.skills[skillId(scope, name)];
    if (!rec || !this.canRead(rec, auth)) throw new HttpError(404, `skill ${skillId(scope, name)} not found`);
    return rec;
  }

  /** Resolve a version spec; "latest" honours a rollback. */
  pick(rec, spec) {
    return !spec || spec === 'latest' ? rec.latest : resolveVersion(Object.keys(rec.versions), spec);
  }

  versions(scope, name, auth) {
    const rec = this.find(scope, name, auth);
    return Object.keys(rec.versions).sort(compareSemver).reverse().map((v) => {
      const x = rec.versions[v];
      return { version: v, current: v === rec.latest, publishedAt: x.publishedAt, publishedBy: x.publishedBy, checksum: x.checksum, size: x.size, files: x.files.length, signed: !!x.signature };
    });
  }

  versionFiles(rec, version) {
    const dir = this.versionDir(rec.scope, rec.name, version);
    return Object.fromEntries(rec.versions[version].files.map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  }

  diff(scope, name, from, to, auth) {
    const rec = this.find(scope, name, auth);
    for (const v of [from, to]) if (!rec.versions[v]) throw new HttpError(404, `${rec.id} has no version ${v}`);
    return { id: rec.id, from, to, files: diffFiles(this.versionFiles(rec, from), this.versionFiles(rec, to)) };
  }

  /** Make an earlier version the current one. History is kept; a later publish moves "latest" forward again. */
  rollback(scope, name, version, auth) {
    const rec = this.find(scope, name, auth);
    if (!this.canPublish(scope, auth)) throw new HttpError(403, 'rollback needs an editor or admin token');
    this.assertWritable(scope);
    if (!rec.versions[version]) throw new HttpError(404, `${rec.id} has no version ${version}`);
    const from = rec.latest;
    rec.latest = version;
    rec.updatedAt = new Date().toISOString();
    this.audit({ action: 'rollback', org: scope, skill: rec.id, version, from }, auth);
    this.save();
    return this.summary(rec);
  }

  get(scope, name, spec, auth) {
    const rec = this.find(scope, name, auth);
    const version = this.pick(rec, spec);
    if (!version) throw new HttpError(404, `no version of ${rec.id} matches ${spec}`);
    const ver = rec.versions[version];
    const skillMd = fs.readFileSync(path.join(this.versionDir(scope, name, version), 'SKILL.md'), 'utf8');
    return {
      ...this.summary(rec),
      version,
      checksum: ver.checksum,
      size: ver.size,
      files: ver.files,
      publishedAt: ver.publishedAt,
      scan: ver.scan || null,
      versions: Object.keys(rec.versions).sort(compareSemver).reverse(),
      skillMd,
    };
  }

  readFile(scope, name, spec, rel, auth) {
    const rec = this.find(scope, name, auth);
    const version = this.pick(rec, spec);
    if (!version) throw new HttpError(404, 'version not found');
    const safe = safeRelPath(rel);
    if (!safe || !rec.versions[version].files.includes(safe)) throw new HttpError(404, `file ${rel} not found`);
    return fs.readFileSync(path.join(this.versionDir(scope, name, version), safe));
  }

  /** Full file bundle for installs; counts as a download. */
  bundle(scope, name, spec, auth, { audit = true } = {}) {
    const info = this.get(scope, name, spec, auth);
    const dir = this.versionDir(scope, name, info.version);
    const files = {};
    for (const f of info.files) files[f] = fs.readFileSync(path.join(dir, f)).toString('base64');
    const rec = this.db.skills[info.id];
    rec.downloads = (rec.downloads || 0) + 1;
    this.save();
    if (audit && (auth || rec.visibility === 'private')) this.audit({ action: 'pull', org: scope, skill: info.id, version: info.version }, auth);
    delete info.skillMd;
    return { ...info, files };
  }

  summary(rec) {
    const m = rec.versions[rec.latest].manifest;
    return {
      id: rec.id,
      scope: rec.scope,
      name: rec.name,
      title: m.title,
      summary: m.summary,
      description: m.description,
      category: m.category,
      tags: m.tags,
      license: m.license,
      author: m.author,
      visibility: rec.visibility,
      latest: rec.latest,
      downloads: rec.downloads || 0,
      updatedAt: rec.updatedAt,
      scanWarnings: rec.versions[rec.latest].scan?.warning ?? null,
      source: rec.source || null,
    };
  }

  /** Search readable skills. Empty query lists everything, most downloaded first. */
  search({ q = '', scope, category, visibility, limit = 100 } = {}, auth) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const rec of Object.values(this.db.skills)) {
      if (!this.canRead(rec, auth)) continue;
      if (scope && rec.scope !== scope) continue;
      if (visibility && rec.visibility !== visibility) continue;
      const s = this.summary(rec);
      if (category && s.category !== category) continue;
      let score = 0;
      if (terms.length) {
        const fields = [
          [s.name, 6], [s.title.toLowerCase(), 5], [s.tags.join(' '), 4],
          [s.summary.toLowerCase(), 2], [s.description.toLowerCase(), 1], [s.scope, 3],
        ];
        for (const t of terms) {
          let hit = 0;
          for (const [text, w] of fields) if (text.includes(t)) hit += w;
          if (!hit) { score = -1; break; }
          score += hit;
        }
        if (score < 0) continue;
      }
      out.push({ ...s, score });
    }
    out.sort((a, b) => b.score - a.score || b.downloads - a.downloads || a.id.localeCompare(b.id));
    return out.slice(0, limit);
  }

  stats(auth) {
    const visible = Object.values(this.db.skills).filter((s) => this.canRead(s, auth));
    const cats = {};
    for (const s of visible) {
      const c = this.summary(s).category;
      cats[c] = (cats[c] || 0) + 1;
    }
    return {
      skills: visible.length,
      public: visible.filter((s) => s.visibility === 'public').length,
      private: visible.filter((s) => s.visibility === 'private').length,
      orgs: new Set(visible.map((s) => s.scope)).size,
      categories: cats,
    };
  }

  events(org) {
    return this.db.events.filter((e) => !org || e.org === org || (e.skill || '').startsWith(`@${org}/`)).slice(-100).reverse();
  }
}

/** Canonical chain hash of an audit entry (everything except its own hash). */
export function auditHash(rec) {
  const { hash, ...rest } = rec;
  return crypto.createHash('sha256').update(`${rest.prev}\n${JSON.stringify(rest)}`).digest('hex');
}

export function verifyAuditFile(file) {
  const r = { ok: true, entries: 0, chained: 0, legacy: 0, head: 'genesis', errors: [] };
  if (!fs.existsSync(file)) return r;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let tip = 'genesis';
  lines.forEach((line, i) => {
    r.entries++;
    let e;
    try { e = JSON.parse(line); } catch { r.errors.push(`line ${i + 1}: not valid JSON`); tip = crypto.createHash('sha256').update(line).digest('hex'); return; }
    if (!e.hash) {
      if (r.chained) r.errors.push(`line ${i + 1}: unchained entry after the chain started`);
      else r.legacy++;
      tip = crypto.createHash('sha256').update(line).digest('hex');
      return;
    }
    r.chained++;
    if (e.prev !== tip) r.errors.push(`line ${i + 1}: prev hash does not match the entry before it (an entry was edited, removed or inserted)`);
    else if (auditHash(e) !== e.hash) r.errors.push(`line ${i + 1}: entry content does not match its hash (edited)`);
    tip = e.hash;
  });
  r.head = tip;
  r.ok = r.errors.length === 0;
  return r;
}

export function hashToken(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// HTTP server: REST API, MCP endpoint (Streamable HTTP, JSON responses) and the web UI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, Store } from './store.js';
import { createMcpHandler } from './mcp.js';
import { createStreamHandler, StreamRegistry } from './stream.js';
import { safeRelPath } from './skill.js';
import { finalizePull, signFiles } from './vault.js';
import { billingConfig, createCheckout, handleStripeEvent, verifyStripeSignature } from './billing.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MAX_BODY = 8 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8', '.py': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8',
};

/** Store-backed registry bound to one caller's auth, for the MCP handler. */
export class LocalRegistry {
  constructor(store, auth) {
    this.store = store;
    this.auth = auth;
  }
  search(opts) { return this.store.search(opts, this.auth); }
  get(scope, name, version) { return this.store.get(scope, name, version, this.auth); }
  readFile(scope, name, version, p) { return this.store.readFile(scope, name, version, p, this.auth).toString('utf8'); }
}

export function createServer({ dataDir = 'data', adminToken = process.env.SKILLYARD_ADMIN_TOKEN, allowedOrigins = [], log = false, publicUrl = process.env.SKILLYARD_PUBLIC_URL, plans = 'off', billing = billingConfig(), stripe } = {}) {
  const store = new Store(dataDir, { plans });
  const routes = [];
  const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn, ...opts });
  const baseOf = (req) => (publicUrl || `http://${req.headers.host}`).replace(/\/+$/, '');
  const SKILL = '/api/skills/@([a-z0-9-]+)/([a-z0-9-]+)';

  route('GET', '/api/health', () => ({ ok: true, plans: store.enforce ? 'enforce' : 'off', billing: billing.configured ? 'stripe' : 'operator' }));
  route('GET', '/api/whoami', ({ auth }) => auth ? { org: auth.org, scopes: auth.scopes, admin: auth.admin, role: auth.role, name: auth.name } : { anonymous: true });
  route('GET', '/api/stats', ({ auth }) => store.stats(auth));
  route('GET', '/api/skills', ({ auth, query }) => ({
    skills: store.search({
      q: query.get('q') || '', scope: query.get('scope') || undefined, category: query.get('category') || undefined,
      visibility: query.get('visibility') || undefined, limit: Math.min(Number(query.get('limit')) || 100, 500),
    }, auth),
  }));
  route('GET', SKILL, ({ auth, m, query }) => store.get(m[1], m[2], query.get('version') || 'latest', auth));
  route('GET', `${SKILL}/bundle`, async ({ auth, m, query, req }) => {
    // Every copy of a private org skill is marked for its recipient, whichever way it is fetched.
    const priv = store.db.skills[`@${m[1]}/${m[2]}`]?.visibility === 'private';
    const pull = query.get('pull') === '1' || priv;
    const b = store.bundle(m[1], m[2], query.get('version') || 'latest', auth, { audit: !pull });
    return pull ? finalizePull(store, b, auth, { baseUrl: baseOf(req) }) : b;
  });
  route('GET', `${SKILL}/versions`, ({ auth, m }) => ({ versions: store.versions(m[1], m[2], auth) }));
  route('GET', `${SKILL}/diff`, ({ auth, m, query }) => store.diff(m[1], m[2], query.get('from'), query.get('to'), auth));
  route('POST', `${SKILL}/rollback`, ({ auth, m, body }) => store.rollback(m[1], m[2], body?.version, auth));
  route('GET', '/api/audit', ({ auth, query }) => {
    const org = auth?.admin ? query.get('org') || undefined : auth?.org;
    if (!auth || !(auth.admin || (auth.role === 'admin' && auth.org))) throw new HttpError(403, 'audit log needs an admin token');
    return { events: store.auditLog({ org, skill: query.get('skill') || undefined, limit: Math.min(Number(query.get('limit')) || 500, 5000) }) };
  });
  route('GET', `${SKILL}/files/(.+)`, async ({ auth, m, query, req }) => {
    const rel = decodeURIComponent(m[3]);
    if (rel === 'SKILL.md' && store.db.skills[`@${m[1]}/${m[2]}`]?.visibility === 'private') {
      const b = await finalizePull(store, store.bundle(m[1], m[2], query.get('version') || 'latest', auth, { audit: false }), auth, { baseUrl: baseOf(req) });
      return { raw: Buffer.from(b.files['SKILL.md'], 'base64'), type: 'text/markdown; charset=utf-8' };
    }
    const buf = store.readFile(m[1], m[2], query.get('version') || 'latest', rel, auth);
    return { raw: buf, type: MIME[path.extname(m[3])] || 'text/plain; charset=utf-8' };
  });
  route('POST', '/api/skills/@([a-z0-9-]+)', async ({ auth, m, body }) => {
    const { files, visibility, force } = body || {};
    if (!files || typeof files !== 'object') throw new HttpError(400, 'body must be {"files": {"path": "<base64>"}}');
    const decoded = {};
    for (const [p, b64] of Object.entries(files)) {
      if (typeof b64 !== 'string') throw new HttpError(400, `file ${p} must be base64 text`);
      decoded[p] = Buffer.from(b64, 'base64');
    }
    const signature = store.getOrg(m[1]) ? await signFiles(decoded, store.getOrg(m[1])) : null;
    return { status: 201, body: store.publish({ scope: m[1], files: decoded, visibility, auth, force: !!force, signature }) };
  });
  route('PATCH', SKILL, ({ auth, m, body }) => store.setVisibility(m[1], m[2], body?.visibility, auth));
  route('DELETE', SKILL, ({ auth, m }) => { store.deleteSkill(m[1], m[2], auth); return { deleted: true }; });

  route('GET', '/api/orgs', ({ auth }) => ({ orgs: store.listOrgs(auth) }));
  route('POST', '/api/orgs', ({ auth, body }) => {
    if (!auth?.admin) throw new HttpError(403, 'admin token required');
    return { status: 201, body: store.createOrg(body || {}) };
  });
  route('PATCH', '/api/orgs/([a-z0-9-]+)', ({ auth, m, body }) => {
    if (!store.isOrgAdmin(auth, m[1])) throw new HttpError(403, 'org admin required');
    if (body?.leaseDays !== undefined) store.setLeaseDays(m[1], body.leaseDays);
    return body?.minGrade === undefined && body?.leaseDays !== undefined ? store.publicOrg(store.getOrg(m[1])) : store.setMinGrade(m[1], body?.minGrade);
  });
  route('GET', '/api/orgs/([a-z0-9-]+)', ({ auth, m }) => {
    const org = store.getOrg(m[1]);
    if (!org) throw new HttpError(404, 'org not found');
    return { ...store.publicOrg(org), member: auth?.org === m[1] || !!auth?.admin, skills: store.search({ scope: m[1], limit: 500 }, auth) };
  });
  const orgManager = (auth, org) => {
    if (!(auth?.admin || (auth?.org === org && auth.scopes.includes('publish')))) throw new HttpError(403, 'a publish token for this org is required');
  };
  route('GET', '/api/orgs/([a-z0-9-]+)/tokens', ({ auth, m }) => { orgManager(auth, m[1]); return { tokens: store.listTokens(m[1]) }; });
  route('POST', '/api/orgs/([a-z0-9-]+)/tokens', ({ auth, m, body }) => {
    orgManager(auth, m[1]);
    const scopes = Array.isArray(body?.scopes) ? body.scopes : ['read'];
    if (scopes.includes('admin')) throw new HttpError(400, 'org tokens cannot have the admin scope');
    const kind = body?.kind === 'service' ? 'service' : 'member';
    if (kind === 'service' && !store.isOrgAdmin(auth, m[1])) throw new HttpError(403, 'only an org admin can create service tokens');
    return { status: 201, body: store.createToken({ org: m[1], name: body?.name || 'token', scopes, kind }, auth) };
  });
  route('DELETE', '/api/orgs/([a-z0-9-]+)/tokens/([a-f0-9]+)', ({ auth, m }) => {
    orgManager(auth, m[1]);
    store.revokeToken(m[2], m[1]);
    return { revoked: true };
  });
  route('GET', '/api/orgs/([a-z0-9-]+)/events', ({ auth, m }) => { orgManager(auth, m[1]); return { events: store.events(m[1]) }; });

  route('POST', '/api/orgs/([a-z0-9-]+)/revoke', ({ auth, m, body }) => {
    if (!store.isOrgAdmin(auth, m[1])) throw new HttpError(403, 'org admin required');
    return store.revokeMember(m[1], String(body?.member || ''), auth);
  });
  route('GET', '/api/orgs/([a-z0-9-]+)/members/([^/]+)/holdings', ({ auth, m }) => {
    if (!store.isOrgAdmin(auth, m[1])) throw new HttpError(403, 'org admin required');
    return store.holdings(m[1], decodeURIComponent(m[2]));
  });

  // ---- plans and billing (docs/plans-and-seats.md)
  route('GET', '/api/orgs/([a-z0-9-]+)/billing', ({ auth, m }) => {
    if (!store.isOrgAdmin(auth, m[1])) throw new HttpError(403, 'org admin required');
    return store.billingState(m[1]);
  });
  route('PATCH', '/api/orgs/([a-z0-9-]+)/plan', ({ auth, m, body }) => {
    if (!auth?.admin) throw new HttpError(403, 'only the server admin (operator) sets plans directly');
    const { plan, seats, status, pilotEndsAt, periodEnd } = body || {};
    return store.setPlan(m[1], { plan, seats, status, pilotEndsAt, periodEnd }, auth);
  });
  route('POST', '/api/orgs/([a-z0-9-]+)/billing/checkout', ({ auth, m, body, req }) => {
    if (!store.isOrgAdmin(auth, m[1])) throw new HttpError(403, 'org admin required');
    return createCheckout(store, m[1], { plan: body?.plan, seats: body?.seats }, { cfg: billing, client: stripe, baseUrl: baseOf(req) });
  });
  route('POST', '/api/billing/webhook', async ({ raw, req }) => {
    verifyStripeSignature(raw, req.headers['stripe-signature'], billing.webhookSecret);
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON body'); }
    return { received: true, ...(await handleStripeEvent(store, event, { cfg: billing, client: stripe })) };
  }, { raw: true });

  route('POST', '/mcp', async ({ auth, body, query }) => {
    if (query.get('stream') === '1' && !auth) throw new HttpError(401, 'stream mode needs your org token');
    if (query.get('stream') === '1' && auth.org) store.assertFeature(auth.org, 'stream');
    const handle = query.get('stream') === '1' ? createStreamHandler(new StreamRegistry(store, auth)) : createMcpHandler(new LocalRegistry(store, auth));
    const res = await handle(body);
    return res === null ? { status: 202, empty: true } : res;
  });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const isApi = url.pathname.startsWith('/api/') || url.pathname === '/mcp';
      if (isApi) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') return send(res, 204);
      }
      if (url.pathname === '/mcp') {
        // DNS-rebinding guard from the MCP spec: browsers send Origin; only allow known ones.
        const origin = req.headers.origin;
        if (origin && !originAllowed(origin, req.headers.host, allowedOrigins)) throw new HttpError(403, 'origin not allowed');
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new HttpError(405, 'this MCP server does not offer an SSE stream; POST JSON-RPC messages'); }
      }
      if (req.method === 'GET' && /^\/r\/[A-Za-z0-9_-]{16,64}$/.test(url.pathname)) return beaconHit(req, res, url.pathname.slice(3));
      if (!isApi) return serveStatic(url.pathname, res);

      const r0 = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      const auth = r0?.raw ? null : store.authenticate(bearer(req), adminToken); // the webhook authenticates by signature
      if (auth) auth.host = String(req.headers['x-skillyard-host'] || '').slice(0, 100) || null;
      const r = r0;
      if (!r) throw new HttpError(404, 'not found');
      const raw = r.raw ? await readBody(req) : undefined;
      const body = !r.raw && ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : undefined;
      const out = await r.fn({ auth, m: r.re.exec(url.pathname), query: url.searchParams, body, raw, req });
      if (out?.raw) return send(res, 200, out.raw, out.type);
      if (out?.empty) return send(res, out.status);
      if (out?.status && out.body) return sendJson(res, out.status, out.body);
      return sendJson(res, 200, out);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (url.pathname === '/mcp' && ![401, 402, 403, 405].includes(status)) {
        return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } });
      }
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="skillyard"');
      return sendJson(res, status, { error: status === 500 ? 'internal error' : e.message });
    } finally {
      if (log) console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  // Beacon: neutral text page; records time, ip, user-agent and referer only for known tokens. Rate-limited.
  const hits = new Map();
  const beaconHit = (req, res, token) => {
    const ip = req.socket.remoteAddress || '';
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.length >= 20) { hits.set(ip, recent); return send(res, 429, 'Too many requests.', 'text/plain; charset=utf-8'); }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    store.recordBeaconHit(token, { ip, userAgent: req.headers['user-agent'], referer: req.headers.referer });
    return send(res, 200, 'Reference material moved; contact the owner.\n', 'text/plain; charset=utf-8');
  };
  server.store = store;
  return server;
}

function originAllowed(origin, host, allowed) {
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  try {
    const o = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'];
    return local.includes(o.hostname) && local.some((h) => (host || '').startsWith(h));
  } catch {
    return false;
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function readJson(req) {
  return readBody(req).then((buf) => {
    if (!buf.length) return undefined;
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON body'); }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type) {
  if (type) res.setHeader('Content-Type', type);
  res.writeHead(status);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : safeRelPath(decodeURIComponent(pathname.slice(1)));
  let file = rel && path.join(WEB_DIR, rel);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(WEB_DIR, 'index.html'); // SPA fallback
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; font-src https://fonts.gstatic.com https://cdn.fontshare.com; connect-src 'self'");
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

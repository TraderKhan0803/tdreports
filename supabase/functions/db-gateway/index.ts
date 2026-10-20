// db-gateway: the only thing allowed to talk to Postgres with the
// service_role key. The browser never sees that key — it sends the
// session token it already stores (issued at login, checked against the
// `sessions` table) and this function re-checks that token before
// forwarding anything to PostgREST.
//
// Two routes are reachable WITHOUT a session token, because they're how a
// session gets created in the first place: /auth/login and /auth/forgot.
// Both are fixed, narrow server-side operations (not generic table access)
// so an anonymous caller still can't read or write anything else.
//
// /auth/login is rate-limited per username via the login_attempts table —
// see the SQL to create it in supabase/migrations/. The route degrades to
// unlimited (but still functional) login attempts if that table is missing.
//
// Every other request is checked against the caller's role as the server
// knows it (session -> users), never the role the browser holds. Account
// changes go through fixed routes (auth/me, auth/logout,
// auth/change-password, users/list, admin/users/*), so the browser never
// touches users or sessions directly. Table access follows a per-role
// allow-list; see "Table access rules" below and GATEWAY_ENFORCE.
// Monthly Updates readers reach only mu/* routes; see "Monthly Updates".
//
// Deploy with: supabase functions deploy db-gateway --no-verify-jwt

// Both of these are injected automatically into every Edge Function by
// the Supabase platform — no manual secret needs to be set.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PROD_ORIGIN = 'https://tdreports.matwagroup.com';
// Local dev only — any localhost/127.0.0.1 port (so picking a different
// static-server port doesn't require editing this file), plus the literal
// "null" origin browsers send for file:// pages. This only changes which
// origins are allowed to READ a response; it has no effect on the
// session-token check, which every authenticated request still requires.
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin: string): boolean {
  return origin === PROD_ORIGIN || origin === 'null' || LOCAL_ORIGIN_RE.test(origin);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin) ? origin : PROD_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, prefer, range, range-unit',
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function svcHeaders(): HeadersInit {
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };
}

// Login rate-limiting — persisted in Postgres (table: login_attempts), not
// in-memory, since an Edge Function instance doesn't reliably survive
// between invocations. Small internal team, so simple counters are enough.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

async function getAttempt(username: string): Promise<{ failed_count: number; locked_until: string | null } | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/login_attempts?username=eq.${encodeURIComponent(username)}&select=failed_count,locked_until`,
      { headers: svcHeaders() },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function recordFailure(username: string, priorCount: number): Promise<string | null> {
  const failed_count = priorCount + 1;
  const locked_until = failed_count >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
  await fetch(`${SUPABASE_URL}/rest/v1/login_attempts?on_conflict=username`, {
    method: 'POST',
    headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ username, failed_count, locked_until }]),
  }).catch(() => {});
  return locked_until;
}

function clearAttempts(username: string): void {
  fetch(`${SUPABASE_URL}/rest/v1/login_attempts?username=eq.${encodeURIComponent(username)}`, {
    method: 'DELETE',
    headers: svcHeaders(),
  }).catch(() => {});
}

async function handleLogin(req: Request): Promise<Response> {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { error: 'Invalid request body' });
  }
  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!username || !password) return json(req, 401, { error: 'Invalid username or password' });

  const attempt = await getAttempt(username);
  if (attempt?.locked_until && new Date(attempt.locked_until) > new Date()) {
    return json(req, 429, { error: 'locked', lockedUntil: attempt.locked_until });
  }

  // Existence check only — never selects the password column, just used
  // to decide whether a wrong-password response includes attemptsLeft.
  const existsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}&select=username`,
    { headers: svcHeaders() },
  );
  if (!existsRes.ok) return json(req, 502, { error: 'Login failed' });
  const userExists = (await existsRes.json()).length > 0;

  // The actual password check happens in Postgres via verify_password —
  // the hash is compared server-side and never sent back here.
  const verifyRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_password`, {
    method: 'POST',
    headers: { ...svcHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_username: username, p_password: password }),
  });
  if (!verifyRes.ok) return json(req, 502, { error: 'Login failed' });
  const matches = await verifyRes.json();
  const passwordOk = Array.isArray(matches) && matches.length > 0;

  if (!passwordOk) {
    const priorCount = attempt?.failed_count || 0;
    const lockedUntil = await recordFailure(username, priorCount);
    if (lockedUntil) return json(req, 429, { error: 'locked', lockedUntil });
    if (userExists) {
      return json(req, 401, { error: 'Invalid username or password', attemptsLeft: MAX_ATTEMPTS - (priorCount + 1) });
    }
    return json(req, 401, { error: 'Invalid username or password' });
  }
  clearAttempts(username);
  const usr = matches[0];
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify([{ token, username, role: usr.role, expires_at: expires }]),
  });
  if (!insertRes.ok) return json(req, 502, { error: 'Login failed' });

  fetch(`${SUPABASE_URL}/rest/v1/sessions?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`, {
    method: 'DELETE',
    headers: svcHeaders(),
  }).catch(() => {});

  return json(req, 200, {
    token,
    username,
    role: usr.role,
    email: usr.email || '',
    must_change_password: !!usr.must_change_password,
  });
}

async function handleForgot(req: Request): Promise<Response> {
  let body: { input?: string };
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { error: 'Invalid request body' });
  }
  const input = (body.input || '').trim();
  if (!input) return json(req, 400, { error: 'Missing username or email' });

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
    method: 'POST',
    headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify([{
      username: input,
      type: 'reset_request',
      message: 'Password reset requested for: ' + input,
      timestamp: new Date().toISOString(),
    }]),
  });
  if (!insertRes.ok) return json(req, 502, { error: 'Request failed' });
  return json(req, 200, { ok: true });
}

// ── Who is calling ───────────────────────────────────────────────────────
// Identity comes only from the server: the session row, joined to `users`
// for the CURRENT role (so a role change or deleted user takes effect on
// the next request), plus the user's user_perms_ row from admin_config.
// The role copy in `sessions` and anything the browser says are ignored.

const PERM_KEYS = ['analytics', 'raabta', 'exec', 'growth', 'downloads', 'templates', 'scenario', 'raabtaAdmin'] as const;
type Perms = Record<typeof PERM_KEYS[number], boolean>;

interface Identity {
  token: string;
  username: string;
  role: string;
  email: string;
  mustChange: boolean;
  perms: Perms;
}

// Mirrors getUserAccess() in index.html, so auth/me reports the same
// screens the dashboard shows.
function permsFor(role: string, stored: Record<string, unknown>): Perms {
  const p = {} as Perms;
  for (const k of PERM_KEYS) {
    if (role === 'super') p[k] = true;
    else if (role === 'admin') p[k] = k !== 'growth' && k !== 'scenario';
    else if (role === 'viewer') p[k] = !!stored[k];
    else p[k] = false;
  }
  return p;
}

const enc = encodeURIComponent;

async function svcGet(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: svcHeaders() });
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`);
  return await res.json();
}

function svcWrite(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function resolveIdentity(token: string): Promise<Identity | null> {
  const sess = await svcGet(
    `sessions?token=eq.${enc(token)}&expires_at=gt.${enc(new Date().toISOString())}&select=username`,
  );
  if (!sess.length) return null;
  const username: string = sess[0].username;
  const [users, permRows] = await Promise.all([
    svcGet(`users?username=eq.${enc(username)}&select=username,role,email,must_change_password`),
    svcGet(`admin_config?type=eq.${enc('user_perms_' + username)}&select=value1&order=updated_at.desc&limit=1`),
  ]);
  if (!users.length) {
    // User was deleted but the session survived — end it.
    svcWrite('DELETE', `sessions?token=eq.${enc(token)}`).catch(() => {});
    return null;
  }
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(permRows[0]?.value1 || '{}') || {};
  } catch { /* malformed row = no flags */ }
  const u = users[0];
  return {
    token,
    username,
    role: u.role || '',
    email: u.email || '',
    mustChange: !!u.must_change_password,
    perms: permsFor(u.role || '', stored),
  };
}

// ── Audit log ────────────────────────────────────────────────────────────
// Only refusals and would-be refusals are logged (never plain allows), so
// big uploads don't flood the table. Session tokens are redacted.

function background(p: Promise<unknown>): void {
  try {
    (globalThis as any).EdgeRuntime?.waitUntil(p);
  } catch { /* fetch is already running either way */ }
}

function audit(who: Identity | null, method: string, path: string, query: string, decision: string, reason: string): void {
  background(
    svcWrite('POST', 'gateway_audit', [{
      username: who?.username ?? null,
      role: who?.role ?? null,
      method,
      path: path.slice(0, 200),
      query: query.replace(/(token=)[^&]*/gi, '$1[redacted]').slice(0, 1000),
      decision,
      reason: reason.slice(0, 500),
    }]).catch(() => {}),
  );
}

// ── Account routes (replace direct users / sessions table access) ────────

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

const NEW_USER_ROLES = ['viewer', 'admin', 'super'];
const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const MIN_PASSWORD = 4; // same minimum the reset-password dialog uses

async function passwordMatches(username: string, password: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_password`, {
    method: 'POST',
    headers: { ...svcHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_username: username, p_password: password }),
  });
  if (!res.ok) throw new Error('verify failed');
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function handleAccountRoute(req: Request, route: string, who: Identity): Promise<Response> {
  const m = req.method;

  if (route === 'auth/me' && m === 'GET') {
    let reader: { profile: string; display_name: string } | null = null;
    if (who.role === 'reader') {
      try {
        const rows = await svcGet(`mu_readers?username=eq.${enc(who.username)}&deleted_at=is.null&select=profile,display_name`);
        reader = rows[0] || null;
      } catch { /* profile is informational; the mu_ functions check it again */ }
    }
    return json(req, 200, {
      username: who.username,
      role: who.role,
      email: who.email,
      perms: who.perms,
      must_change_password: who.mustChange,
      ...(reader ? { profile: reader.profile, display_name: reader.display_name } : {}),
    });
  }

  if (route === 'auth/logout' && m === 'POST') {
    await svcWrite('DELETE', `sessions?token=eq.${enc(who.token)}`).catch(() => {});
    return json(req, 200, { ok: true });
  }

  if (route === 'auth/change-password' && m === 'POST') {
    const body = await readJson(req);
    const newPw = typeof body?.new_password === 'string' ? body.new_password : '';
    if (newPw.length < MIN_PASSWORD) return json(req, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
    // The first-login screen has no current-password field, so it's only
    // required once must_change_password has been cleared. Wrong guesses
    // count toward the same lockout as the login screen.
    if (!who.mustChange) {
      const attempt = await getAttempt(who.username);
      if (attempt?.locked_until && new Date(attempt.locked_until) > new Date()) {
        return json(req, 429, { error: 'locked', lockedUntil: attempt.locked_until });
      }
      const current = typeof body?.current_password === 'string' ? body.current_password : '';
      let ok = false;
      try {
        ok = !!current && await passwordMatches(who.username, current);
      } catch {
        return json(req, 502, { error: 'Password change failed' });
      }
      if (!ok) {
        await recordFailure(who.username, attempt?.failed_count || 0);
        return json(req, 403, { error: 'Current password is incorrect' });
      }
      clearAttempts(who.username);
    }
    const res = await svcWrite('PATCH', `users?username=eq.${enc(who.username)}`, {
      password: newPw,
      must_change_password: false,
    });
    if (!res.ok) return json(req, 502, { error: 'Password change failed' });
    // Sign out every other session of this user; keep the current one.
    await svcWrite('DELETE', `sessions?username=eq.${enc(who.username)}&token=neq.${enc(who.token)}`).catch(() => {});
    return json(req, 200, { ok: true });
  }

  // Everything below needs a completed first-login password change.
  if (who.mustChange) {
    if (ENFORCE) return json(req, 403, { error: 'Password change required' });
    audit(who, m, route, '', 'would_block', 'must change password first');
  }

  if (route === 'users/list' && m === 'GET') {
    if (who.role === 'reader') return json(req, 403, { error: 'Forbidden' });
    // Reader accounts (partners, investors…) are listed for super only.
    const notReaders = who.role === 'super' ? '' : '&role=neq.reader';
    try {
      return json(req, 200, await svcGet(`users?select=username,role,email&order=username.asc${notReaders}`));
    } catch {
      return json(req, 502, { error: 'Lookup failed' });
    }
  }

  // Manual fallback for the new-customer flag. Triggers normally keep it
  // correct (supabase/migrations/20261020_new_customers_part2.sql); this
  // recomputes every order in the database, not just what a browser loaded.
  if (route === 'admin/recalc-new-customers' && m === 'POST') {
    if (who.role !== 'super' && who.role !== 'admin') {
      audit(who, m, route, '', 'block', 'super/admin only');
      return json(req, 403, { error: 'Forbidden' });
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/refresh_new_customer_flags`, {
      method: 'POST',
      headers: { ...svcHeaders(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return json(req, 502, { error: 'Recalculation failed' });
    return json(req, 200, { changed: Number(await res.json()) || 0 });
  }

  if (!route.startsWith('admin/users') || m !== 'POST') return json(req, 404, { error: 'Not found' });
  if (who.role !== 'super') {
    audit(who, m, route, '', 'block', 'super only');
    return json(req, 403, { error: 'Forbidden' });
  }
  const body = await readJson(req);
  if (!body) return json(req, 400, { error: 'Invalid request body' });
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!username) return json(req, 400, { error: 'Missing username' });

  if (route === 'admin/users') {
    const password = typeof body.password === 'string' ? body.password : '';
    const role = typeof body.role === 'string' ? body.role : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!USERNAME_RE.test(username)) return json(req, 400, { error: 'Username may only use letters, numbers and . _ @ -' });
    if (password.length < MIN_PASSWORD) return json(req, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
    if (role === 'reader') {
      // Monthly Updates reader: users row + mu_readers row, created together.
      const profile = typeof body.profile === 'string' ? body.profile : '';
      const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
      if (!MU_PROFILES.includes(profile)) return json(req, 400, { error: 'Invalid profile' });
      if (!displayName) return json(req, 400, { error: 'Missing display name' });
      const r = await muRpc('mu_create_reader', {
        p_by: who.username, p_username: username, p_password: password, p_email: email,
        p_profile: profile, p_display_name: displayName,
      });
      return json(req, r.status, r.body);
    }
    if (!NEW_USER_ROLES.includes(role)) return json(req, 400, { error: 'Invalid role' });
    const res = await svcWrite('POST', 'users', [{ username, password, role, email, must_change_password: true }]);
    if (res.status === 409) return json(req, 409, { error: 'User already exists' });
    if (!res.ok) return json(req, 502, { error: 'Could not create user' });
    return json(req, 200, { ok: true });
  }

  let target: any[];
  try {
    target = await svcGet(`users?username=eq.${enc(username)}&select=username,role`);
  } catch {
    return json(req, 502, { error: 'Lookup failed' });
  }
  if (!target.length) return json(req, 404, { error: 'User not found' });

  if (route === 'admin/users/reset-password') {
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD) return json(req, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
    const res = await svcWrite('PATCH', `users?username=eq.${enc(username)}`, { password, must_change_password: true });
    if (!res.ok) return json(req, 502, { error: 'Reset failed' });
    await svcWrite('DELETE', `sessions?username=eq.${enc(username)}`).catch(() => {});
    return json(req, 200, { ok: true });
  }

  if (route === 'admin/users/delete') {
    if (target[0].role === 'super') {
      let supers: any[];
      try {
        supers = await svcGet('users?role=eq.super&select=username');
      } catch {
        return json(req, 502, { error: 'Lookup failed' });
      }
      if (supers.length <= 1) return json(req, 409, { error: 'Cannot delete the last super admin' });
    }
    const res = await svcWrite('DELETE', `users?username=eq.${enc(username)}`);
    if (!res.ok) return json(req, 502, { error: 'Delete failed' });
    await Promise.all([
      svcWrite('DELETE', `sessions?username=eq.${enc(username)}`),
      svcWrite('DELETE', `admin_config?type=eq.${enc('user_perms_' + username)}`),
      svcWrite('DELETE', `admin_config?type=eq.${enc('panelLayout_' + username)}`),
    ]).catch(() => {});
    return json(req, 200, { ok: true });
  }

  if (route === 'admin/users/permissions') {
    const raw = body.perms && typeof body.perms === 'object' ? body.perms as Record<string, unknown> : {};
    const perms: Record<string, boolean> = {};
    for (const k of PERM_KEYS) if (k in raw) perms[k] = !!raw[k];
    const type = 'user_perms_' + username;
    const del = await svcWrite('DELETE', `admin_config?type=eq.${enc(type)}`);
    if (!del.ok) return json(req, 502, { error: 'Save failed' });
    const ins = await svcWrite('POST', 'admin_config', [{
      type,
      value1: JSON.stringify(perms),
      value2: '',
      updated_by: who.username,
      updated_at: new Date().toISOString(),
    }]);
    if (!ins.ok) return json(req, 502, { error: 'Save failed' });
    return json(req, 200, { ok: true });
  }

  return json(req, 404, { error: 'Not found' });
}

// ── Table access rules ───────────────────────────────────────────────────
//
// GATEWAY_ENFORCE (Edge Function secret): 'on' refuses anything the rules
// below don't allow, and applies the rewrites (forced username filters,
// admin_config row filtering for viewers). Anything else — the default —
// is log-only: requests go through unchanged and what WOULD have happened
// is written to gateway_audit ('would_block' / 'would_narrow' /
// 'would_filter').
//
// The HARD blocks in the request handler apply in both modes: the users,
// sessions, login_attempts and gateway_audit tables, rpc/* or any other
// path that isn't a plain table name, and any table access by a reader.

const ENFORCE = Deno.env.get('GATEWAY_ENFORCE') === 'on';

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HARD_BLOCKED = new Set(['users', 'sessions', 'login_attempts', 'gateway_audit']);
const DATA_TABLES = new Set([
  'orders', 'products', 'admin_config', 'customer_links', 'financials', 'raabta_log', 'campaigns',
  'vip_customers', 'alerts', 'activity_log', 'ai_usage', 'ai_user_limits', 'ai_conversations',
]);
// PostgREST query params that shape the result but don't filter rows.
const NON_FILTER_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

// admin_config types any viewer may read. On top of these: their own
// user_perms_ / panelLayout_ rows, waNumber_* / outcome_* with the raabta
// flag, tezz_cac_spend / effective_margin_rate with exec/growth/scenario. Everything else (other users' rows, upload batches,
// anything unknown) is filtered out of viewer responses.
const VIEWER_CONFIG_TYPES = new Set(['b2b', 'testRule', 'cityMapping', 'manualCity']);

type Decision =
  | { ok: false; reason: string }
  | {
    ok: true;
    params?: URLSearchParams; // rewritten query (enforce mode only)
    body?: string; // rewritten body (enforce mode only)
    narrowed?: string; // what the rewrite changed, for the log-only audit
    keepRow?: (row: Record<string, unknown>) => boolean; // response row filter
  };

const deny = (reason: string): Decision => ({ ok: false, reason });
const allow: Decision = { ok: true };

function hasFilter(params: URLSearchParams): boolean {
  for (const k of params.keys()) if (!NON_FILTER_PARAMS.has(k)) return true;
  return false;
}

function parseRows(bodyText: string | undefined): { rows: Record<string, unknown>[]; single: boolean } | null {
  try {
    const b = JSON.parse(bodyText || '');
    if (Array.isArray(b) && b.every((r) => r && typeof r === 'object')) return { rows: b, single: false };
    if (b && typeof b === 'object') return { rows: [b], single: true };
  } catch { /* fall through */ }
  return null;
}

// The specific admin_config types a DELETE/PATCH filter can touch, or null
// if the filter doesn't pin them down (no `type`, or like./neq. etc).
function typesFromFilter(params: URLSearchParams): string[] | null {
  for (const v of params.getAll('type')) {
    if (v.startsWith('eq.')) return [v.slice(3)];
    if (v.startsWith('in.(') && v.endsWith(')')) return v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
  }
  return null;
}

// Add col=eq.val to the query; PostgREST ANDs it with whatever the client sent.
function forceFilter(params: URLSearchParams, col: string, val: string): Decision {
  const already = params.getAll(col).includes('eq.' + val);
  if (already) return allow;
  const p = new URLSearchParams(params);
  p.append(col, 'eq.' + val);
  return { ok: true, params: p, narrowed: `added ${col}=eq.${val}` };
}

// Overwrite one field on every inserted/updated row.
function forceField(bodyText: string | undefined, field: string, val: string): Decision {
  const parsed = parseRows(bodyText);
  if (!parsed) return deny('unreadable body');
  const changed = parsed.rows.some((r) => r[field] !== val);
  if (!changed) return allow;
  const rows = parsed.rows.map((r) => ({ ...r, [field]: val }));
  return { ok: true, body: JSON.stringify(parsed.single ? rows[0] : rows), narrowed: `set ${field}=${val}` };
}

function bodyKeysWithin(bodyText: string | undefined, allowed: string[]): boolean {
  const parsed = parseRows(bodyText);
  return !!parsed && parsed.rows.every((r) => Object.keys(r).every((k) => allowed.includes(k)));
}

function evaluate(
  who: Identity,
  method: string,
  table: string,
  params: URLSearchParams,
  bodyText: string | undefined,
  prefer: string,
): Decision {
  if (!DATA_TABLES.has(table)) return deny('unknown table');
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return deny('method not allowed');
  if ((params.get('select') || '').includes('(')) return deny('embedded select');
  if ((method === 'DELETE' || method === 'PATCH') && !hasFilter(params)) return deny('unfiltered ' + method);
  if (who.mustChange) return deny('must change password first');

  if (who.role === 'super') return allow;
  if (who.role === 'admin') return adminRule(method, table, params, bodyText);
  if (who.role === 'viewer') return viewerRule(who, method, table, params, bodyText, prefer);
  return deny(`role '${who.role}' has no table access`);
}

// Admin: same access as super, except user_perms_ rows are super-only.
function adminRule(method: string, table: string, params: URLSearchParams, bodyText: string | undefined): Decision {
  if (table !== 'admin_config' || method === 'GET') return allow;
  if (method === 'POST') {
    const parsed = parseRows(bodyText);
    if (!parsed) return deny('unreadable body');
    if (parsed.rows.some((r) => String(r.type || '').startsWith('user_perms_'))) return deny('user_perms_ is super only');
    return allow;
  }
  const types = typesFromFilter(params);
  if (!types) return deny('admin_config write needs a specific type');
  if (types.some((t) => t.startsWith('user_perms_'))) return deny('user_perms_ is super only');
  return allow;
}

// Viewer: read-only on data tables (by screen flag), plus writes to their
// own personal rows, plus Raabta writes when they have the raabta flag.
function viewerRule(
  who: Identity,
  method: string,
  table: string,
  params: URLSearchParams,
  bodyText: string | undefined,
  prefer: string,
): Decision {
  const p = who.perms;
  const me = who.username;
  const anyData = p.analytics || p.downloads || p.exec || p.growth || p.scenario || p.raabta || p.raabtaAdmin;
  const fin = p.exec || p.growth || p.scenario;
  const rb = p.raabta || p.raabtaAdmin;

  const configTypeWritable = (t: string) =>
    t === 'panelLayout_' + me || (p.raabtaAdmin && (t.startsWith('waNumber_') || t.startsWith('outcome_')));

  // An upsert can overwrite someone else's row, so viewers only insert.
  if (method !== 'GET' && (prefer.includes('merge-duplicates') || params.has('on_conflict'))) {
    return deny('viewers cannot upsert');
  }

  if (method === 'GET') {
    switch (table) {
      case 'orders':
      case 'products':
      case 'customer_links':
      case 'vip_customers':
        return anyData ? allow : deny('no data screens');
      case 'financials':
        return fin ? allow : deny('needs exec/growth/scenario');
      case 'raabta_log':
      case 'campaigns':
        return rb ? allow : deny('needs raabta');
      case 'alerts':
        return allow;
      case 'ai_usage':
      case 'ai_user_limits':
      case 'ai_conversations':
        return forceFilter(params, 'username', me);
      case 'admin_config': {
        const sel = params.get('select');
        if (sel && sel !== '*' && !sel.split(',').includes('type')) return deny('admin_config read must include type');
        return {
          ok: true,
          keepRow: (r) => {
            const t = String(r.type || '');
            return VIEWER_CONFIG_TYPES.has(t) ||
              t === 'user_perms_' + me || t === 'panelLayout_' + me ||
              (rb && (t.startsWith('waNumber_') || t.startsWith('outcome_'))) ||
              (fin && (t === 'tezz_cac_spend' || t === 'effective_margin_rate'));
          },
        };
      }
    }
    return deny('not readable by viewers');
  }

  if (method === 'POST') {
    switch (table) {
      case 'activity_log':
      case 'ai_usage':
      case 'ai_conversations':
        return forceField(bodyText, 'username', me);
      case 'alerts':
        return forceField(bodyText, 'created_by', me);
      case 'raabta_log':
        return rb ? forceField(bodyText, 'username', me) : deny('needs raabta');
      case 'campaigns':
        return rb ? allow : deny('needs raabta');
      case 'admin_config': {
        const parsed = parseRows(bodyText);
        if (!parsed) return deny('unreadable body');
        return parsed.rows.every((r) => configTypeWritable(String(r.type || '')))
          ? allow
          : deny('admin_config type not writable by this viewer');
      }
    }
    return deny('not writable by viewers');
  }

  if (method === 'PATCH') {
    switch (table) {
      case 'ai_usage':
        return forceFilter(params, 'username', me);
      case 'alerts': {
        if (!bodyKeysWithin(bodyText, ['dismissed', 'dismissed_by', 'dismissed_at'])) return deny('viewers can only dismiss alerts');
        const f = forceFilter(params, 'created_by', me);
        const b = forceField(bodyText, 'dismissed_by', me);
        if (!b.ok) return b;
        return {
          ok: true,
          params: (f as any).params,
          body: (b as any).body,
          narrowed: [(f as any).narrowed, (b as any).narrowed].filter(Boolean).join('; ') || undefined,
        };
      }
      case 'campaigns':
        return rb ? allow : deny('needs raabta');
      case 'raabta_log':
        return p.raabtaAdmin && bodyKeysWithin(bodyText, ['outcome']) ? allow : deny('needs raabtaAdmin');
    }
    return deny('not updatable by viewers');
  }

  // DELETE
  switch (table) {
    case 'ai_conversations':
      return forceFilter(params, 'username', me);
    case 'campaigns':
      return rb ? allow : deny('needs raabta');
    case 'admin_config': {
      const types = typesFromFilter(params);
      return types && types.every(configTypeWritable) ? allow : deny('admin_config type not deletable by this viewer');
    }
  }
  return deny('not deletable by viewers');
}

// ── Monthly Updates ──────────────────────────────────────────────────────
//
// Readers never touch tables: every reader request is a mu/* route that
// calls a mu_* database function with p_username = the session's user, so
// the database filters everything to their profile. Super uses the editor
// tables directly, plus mu/admin/* routes. These rules apply in both
// GATEWAY_ENFORCE modes. See supabase/migrations/20261021_monthly_updates_phase1.sql.

const MU_PROFILES = ['partner', 'investor', 'employee', 'prospect_investor', 'prospect_partner'];
// Super may read and write these as tables (the Phase 2 editor).
const MU_EDITOR_TABLES = new Set([
  'mu_updates', 'mu_stories', 'mu_items', 'mu_item_tags', 'mu_story_tags',
  'mu_section_defaults', 'mu_section_audience', 'mu_readers',
]);
// Super may only read these; mu_publish / mu_ensure_aliases write them.
const MU_READONLY_TABLES = new Set(['mu_sections', 'mu_customer_aliases']);
// mu_notes and mu_reads (and any other mu_ table) are never tables to the
// browser — not even for super, who sees only sent notes via a function.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;

function muTableRule(who: Identity, method: string, table: string, params: URLSearchParams): string | null {
  if (who.role !== 'super') return 'Monthly Updates tables are super only';
  if (who.mustChange) return 'must change password first';
  if ((params.get('select') || '').includes('(')) return 'embedded select';
  if ((method === 'DELETE' || method === 'PATCH') && !hasFilter(params)) return 'unfiltered ' + method;
  if (MU_EDITOR_TABLES.has(table)) return ['GET', 'POST', 'PATCH', 'DELETE'].includes(method) ? null : 'method not allowed';
  if (MU_READONLY_TABLES.has(table)) return method === 'GET' ? null : 'read-only table';
  return 'table is not reachable from the browser';
}

// Call a mu_* function. 'mu: …' exceptions become 404 / 403 / 400 with the
// message; anything else is a 502 without database details.
async function muRpc(fn: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { ...svcHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    return { status: 502, body: { error: 'Request failed' } };
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch { /* leave null */ }
  if (res.ok) return { status: 200, body: data };
  const msg = typeof data?.message === 'string' ? data.message : '';
  if (msg.startsWith('mu: not found')) return { status: 404, body: { error: 'Not found' } };
  if (msg.startsWith('mu: forbidden')) return { status: 403, body: { error: 'Forbidden' } };
  if (msg.startsWith('mu: ')) return { status: 400, body: { error: msg.slice(4) } };
  if (typeof data?.code === 'string' && data.code.startsWith('22')) return { status: 400, body: { error: 'Invalid request' } };
  return { status: 502, body: { error: 'Request failed' } };
}

async function handleMuRoute(req: Request, route: string, url: URL, who: Identity): Promise<Response> {
  const m = req.method;
  const qp = (k: string) => url.searchParams.get(k) || '';
  const reply = (r: { status: number; body: unknown }) => json(req, r.status, r.body);
  const bad = (msg: string) => json(req, 400, { error: msg });
  const refuse = (reason: string) => {
    audit(who, m, route, url.search.slice(1), 'block', reason);
    return json(req, 403, { error: 'Forbidden' });
  };
  if (who.mustChange) return json(req, 403, { error: 'Password change required' });

  if (route.startsWith('mu/admin/')) {
    if (who.role !== 'super') return refuse('Monthly Updates admin is super only');
    const body = m === 'POST' ? await readJson(req) : null;
    if (m === 'POST' && !body) return bad('Invalid request body');
    switch (`${m} ${route}`) {
      case 'GET mu/admin/questions': {
        const id = qp('update_id');
        if (id && !UUID_RE.test(id)) return bad('Invalid update_id');
        return reply(await muRpc('mu_admin_questions', { p_update_id: id || null }));
      }
      case 'POST mu/admin/reply':
        if (!UUID_RE.test(String(body!.note_id))) return bad('Invalid note_id');
        return reply(await muRpc('mu_admin_reply', { p_by: who.username, p_note_id: body!.note_id, p_reply: String(body!.reply ?? '') }));
      case 'GET mu/admin/reads':
        if (!UUID_RE.test(qp('update_id'))) return bad('Invalid update_id');
        return reply(await muRpc('mu_admin_read_summary', { p_update_id: qp('update_id') }));
      case 'GET mu/admin/new-customers':
        if (!MONTH_RE.test(qp('from')) || !MONTH_RE.test(qp('to'))) return bad('from / to must be YYYY-MM-01');
        return reply(await muRpc('mu_new_customer_counts', { p_from: qp('from'), p_to: qp('to') }));
      case 'POST mu/admin/aliases': {
        const keys = body!.keys;
        if (!Array.isArray(keys) || keys.length > 20000 || !keys.every((k) => typeof k === 'string')) return bad('keys must be a list of strings');
        return reply(await muRpc('mu_ensure_aliases', { p_keys: keys }));
      }
      case 'POST mu/admin/publish':
        if (!UUID_RE.test(String(body!.update_id))) return bad('Invalid update_id');
        if (!Array.isArray(body!.sections)) return bad('sections must be a list');
        return reply(await muRpc('mu_publish', { p_by: who.username, p_update_id: body!.update_id, p_sections: body!.sections }));
      case 'POST mu/admin/unpublish':
        if (!UUID_RE.test(String(body!.update_id))) return bad('Invalid update_id');
        return reply(await muRpc('mu_unpublish', { p_by: who.username, p_update_id: body!.update_id }));
    }
    return json(req, 404, { error: 'Not found' });
  }

  // Reader routes. The username always comes from the session; anything
  // the browser sends as a username is ignored.
  if (who.role !== 'reader') return refuse('Monthly Updates reader routes are for readers');
  const me = who.username;
  const body = m === 'POST' ? await readJson(req) : null;
  if (m === 'POST' && !body) return bad('Invalid request body');
  switch (`${m} ${route}`) {
    case 'GET mu/updates':
      return reply(await muRpc('mu_list_updates', { p_username: me }));
    case 'GET mu/update':
      if (!MONTH_RE.test(qp('month'))) return bad('month must be YYYY-MM-01');
      return reply(await muRpc('mu_get_update', { p_username: me, p_month: qp('month') }));
    case 'GET mu/story':
      if (!UUID_RE.test(qp('id'))) return bad('Invalid id');
      return reply(await muRpc('mu_story_timeline', { p_username: me, p_story_id: qp('id') }));
    case 'GET mu/notes':
      return reply(await muRpc('mu_my_notes', { p_username: me }));
    case 'POST mu/notes': {
      const send = body!.send;
      if (!UUID_RE.test(String(body!.update_id))) return bad('Invalid update_id');
      if (send !== undefined && send !== null && typeof send !== 'boolean') return bad('send must be true or false');
      return reply(await muRpc('mu_save_note', {
        p_username: me,
        p_update_id: body!.update_id,
        p_target_type: String(body!.target_type ?? ''),
        p_target_id: String(body!.target_id ?? ''),
        p_body: String(body!.body ?? ''),
        p_send: send ?? null,
      }));
    }
    case 'POST mu/notes/delete':
      if (!UUID_RE.test(String(body!.id))) return bad('Invalid id');
      return reply(await muRpc('mu_delete_note', { p_username: me, p_note_id: body!.id }));
    case 'POST mu/reads': {
      if (!UUID_RE.test(String(body!.update_id))) return bad('Invalid update_id');
      const seconds = Number(body!.seconds ?? 0);
      if (!Number.isFinite(seconds)) return bad('Invalid seconds');
      const tab = body!.tab === undefined || body!.tab === null ? null : String(body!.tab);
      return reply(await muRpc('mu_record_read', { p_username: me, p_update_id: body!.update_id, p_seconds: Math.round(seconds), p_tab: tab }));
    }
  }
  return json(req, 404, { error: 'Not found' });
}

// ── Request handler ──────────────────────────────────────────────────────

async function forward(req: Request, table: string, search: string, bodyText: string | undefined): Promise<Response> {
  const fwdHeaders = new Headers(svcHeaders());
  for (const h of ['content-type', 'prefer', 'range', 'range-unit']) {
    const v = req.headers.get(h);
    if (v) fwdHeaders.set(h, v);
  }
  return await fetch(`${SUPABASE_URL}/rest/v1/${table}${search}`, {
    method: req.method,
    headers: fwdHeaders,
    body: bodyText,
  });
}

function relay(req: Request, pgRes: Response, body: BodyInit | null): Response {
  const resHeaders = new Headers(corsHeaders(req));
  const ct = pgRes.headers.get('content-type');
  if (ct) resHeaders.set('content-type', ct);
  const cr = pgRes.headers.get('content-range');
  if (cr) resHeaders.set('content-range', cr);
  return new Response(body, { status: pgRes.status, headers: resHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const fnIdx = segments.lastIndexOf('db-gateway');
  const route = segments.slice(fnIdx + 1).join('/');
  if (!route) return json(req, 400, { error: 'Missing table path' });

  if (route === 'auth/login' && req.method === 'POST') return handleLogin(req);
  if (route === 'auth/forgot' && req.method === 'POST') return handleForgot(req);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(req, 401, { error: 'Unauthorized' });

  let who: Identity | null;
  try {
    who = await resolveIdentity(token);
  } catch {
    return json(req, 502, { error: 'Session check failed' });
  }
  if (!who) return json(req, 401, { error: 'Unauthorized' });

  if (route.startsWith('auth/') || route.startsWith('admin/') || route === 'users/list') {
    return handleAccountRoute(req, route, who);
  }
  if (route.startsWith('mu/')) return handleMuRoute(req, route, url, who);

  // Hard blocks — both modes.
  const query = url.search.slice(1);
  let hardReason = '';
  if (!TABLE_RE.test(route)) hardReason = 'not a table path';
  else if (HARD_BLOCKED.has(route)) hardReason = 'table is never reachable from the browser';
  else if (who.role === 'reader') hardReason = 'readers have no table access';
  else if (route.startsWith('mu_')) hardReason = muTableRule(who, req.method, route, url.searchParams) || '';
  if (hardReason) {
    audit(who, req.method, route, query, 'block', hardReason);
    return json(req, 403, { error: 'Forbidden' });
  }

  const bodyText = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text();
  // Allowed mu_ table request (super, editor tables): no further rules.
  if (route.startsWith('mu_')) {
    const pgRes = await forward(req, route, url.search, bodyText);
    return relay(req, pgRes, pgRes.body);
  }
  const d = evaluate(who, req.method, route, url.searchParams, bodyText, req.headers.get('prefer') || '');

  if (!d.ok) {
    if (ENFORCE) {
      audit(who, req.method, route, query, 'block', d.reason);
      return json(req, 403, { error: 'Forbidden', reason: d.reason });
    }
    audit(who, req.method, route, query, 'would_block', d.reason);
    const pgRes = await forward(req, route, url.search, bodyText);
    return relay(req, pgRes, pgRes.body);
  }

  if (!ENFORCE && d.narrowed) audit(who, req.method, route, query, 'would_narrow', d.narrowed);

  const search = ENFORCE && d.params ? '?' + d.params.toString() : url.search;
  const pgRes = await forward(req, route, search, ENFORCE && d.body !== undefined ? d.body : bodyText);
  const keepRow = d.keepRow;
  if (!keepRow || !pgRes.ok) return relay(req, pgRes, pgRes.body);

  // Row-filtered read (viewer admin_config): buffer, filter, return.
  const text = await pgRes.text();
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return relay(req, pgRes, text);
  }
  if (!Array.isArray(rows)) return relay(req, pgRes, text);
  const kept = rows.filter((r) => keepRow(r as Record<string, unknown>));
  if (!ENFORCE) {
    if (kept.length < rows.length) {
      const dropped = [...new Set(rows.filter((r) => !kept.includes(r)).map((r: any) => String(r?.type ?? '')))];
      audit(who, req.method, route, query, 'would_filter', 'types: ' + dropped.join(', '));
    }
    return relay(req, pgRes, text);
  }
  return relay(req, pgRes, JSON.stringify(kept));
});

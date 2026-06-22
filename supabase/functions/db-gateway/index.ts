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

  let sessions: Array<{ username: string; role: string }>;
  try {
    const sessRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=username,role`,
      { headers: svcHeaders() },
    );
    if (!sessRes.ok) return json(req, 502, { error: 'Session check failed' });
    sessions = await sessRes.json();
  } catch {
    return json(req, 502, { error: 'Session check failed' });
  }
  if (!sessions.length) return json(req, 401, { error: 'Unauthorized' });

  const targetUrl = `${SUPABASE_URL}/rest/v1/${route}${url.search}`;
  const fwdHeaders = new Headers(svcHeaders());
  for (const h of ['content-type', 'prefer', 'range', 'range-unit']) {
    const v = req.headers.get(h);
    if (v) fwdHeaders.set(h, v);
  }

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const pgRes = await fetch(targetUrl, {
    method: req.method,
    headers: fwdHeaders,
    body: hasBody ? await req.text() : undefined,
  });

  const resHeaders = new Headers(corsHeaders(req));
  const ct = pgRes.headers.get('content-type');
  if (ct) resHeaders.set('content-type', ct);
  const cr = pgRes.headers.get('content-range');
  if (cr) resHeaders.set('content-range', cr);

  return new Response(pgRes.body, { status: pgRes.status, headers: resHeaders });
});

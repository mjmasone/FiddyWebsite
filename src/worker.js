/**
 * fiddyfiddy.org — static site + unsubscribe endpoint.
 *
 * Static assets in ../public are served directly by the edge; this Worker only
 * runs for paths that don't match a file:
 *
 *   GET  /unsubscribe?e=<email>  — show the address and a confirm button
 *   POST /unsubscribe            — record the opt-out, show confirmation
 *   GET  /api/suppressions       — JSON list, bearer-token protected
 *
 * The opt-out is only written on POST, never on GET, so mail-client link
 * prefetchers and security scanners can't suppress an address by following
 * the link.
 */

const SOURCE = 'operator-outreach';

// RFC 5321 caps the whole address at 254 octets. Anything longer is junk, and
// rejecting it early keeps a public unauthenticated write endpoint from being
// used to bloat the table.
const MAX_EMAIL_LENGTH = 254;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/unsubscribe') return handleUnsubscribe(request, env, url);
    if (path === '/api/suppressions') return handleSuppressions(request, env);

    // assets.html_handling is "none" so that /organizer-guide.html keeps
    // serving at that exact path instead of redirecting. That also turns off
    // the edge's automatic "/" -> index.html mapping, so do it here.
    if (path === '/') {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }

    return env.ASSETS.fetch(request);
  },
};

/* -------------------------------------------------------------------------- */
/* /unsubscribe                                                               */
/* -------------------------------------------------------------------------- */

async function handleUnsubscribe(request, env, url) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const email = normalizeEmail(readQueryEmail(url));

    // Missing or malformed ?e= isn't an error — fall through to manual entry.
    return isValidEmail(email)
      ? renderConfirmPrompt(email)
      : renderManualEntry();
  }

  if (request.method === 'POST') {
    const submitted = normalizeEmail(await readSubmittedEmail(request));

    if (!isValidEmail(submitted)) {
      return renderManualEntry({
        error: submitted
          ? "That doesn't look like a valid email address."
          : 'Please enter the email address you want removed.',
        value: submitted,
        status: 400,
      });
    }

    await suppress(env, submitted);
    return renderConfirmed(submitted);
  }

  return methodNotAllowed('GET, POST');
}

/**
 * Records the opt-out. Idempotent: re-submitting an address that's already
 * suppressed is a no-op and still reports success to the caller.
 */
async function suppress(env, email) {
  const db = requireDatabase(env);
  await ensureSchema(db);

  await db
    .prepare(
      `INSERT INTO suppressions (email, suppressed_at, source)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(email) DO NOTHING`
    )
    .bind(email, new Date().toISOString(), SOURCE)
    .run();
}

/* -------------------------------------------------------------------------- */
/* /api/suppressions                                                          */
/* -------------------------------------------------------------------------- */

async function handleSuppressions(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed('GET');
  }

  const expected = env.SUPPRESSIONS_API_TOKEN;

  // Never fail open. An unset token means misconfigured, not public.
  if (!expected) {
    return jsonResponse(
      { error: 'Suppression API is not configured.' },
      { status: 503 }
    );
  }

  const presented = bearerToken(request.headers.get('Authorization'));

  if (!presented || !timingSafeEqual(presented, expected)) {
    return jsonResponse(
      { error: 'Unauthorized.' },
      {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="suppressions"' },
      }
    );
  }

  const db = requireDatabase(env);
  await ensureSchema(db);

  const { results } = await db
    .prepare(
      `SELECT email, suppressed_at, source
         FROM suppressions
        ORDER BY suppressed_at ASC`
    )
    .all();

  const suppressions = results ?? [];

  return jsonResponse({
    count: suppressions.length,
    generated_at: new Date().toISOString(),
    suppressions,
  });
}

function bearerToken(header) {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Compares two strings without leaking match position through timing. Length
 * is still observable, which is the standard, accepted tradeoff.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

function requireDatabase(env) {
  if (!env.SUPPRESSIONS_DB) {
    throw new Error(
      'SUPPRESSIONS_DB binding is missing. See README.md for D1 setup.'
    );
  }
  return env.SUPPRESSIONS_DB;
}

// Per-isolate latch so the DDL runs about once per cold start rather than once
// per request. schema.sql is the canonical definition; this only makes a fresh
// database self-healing if `npm run db:init` was skipped.
let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;

  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS suppressions (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         email         TEXT NOT NULL UNIQUE,
         suppressed_at TEXT NOT NULL,
         source        TEXT NOT NULL
       )`
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_suppressions_suppressed_at
         ON suppressions (suppressed_at)`
    ),
  ]);

  schemaReady = true;
}

/* -------------------------------------------------------------------------- */
/* Email handling                                                             */
/* -------------------------------------------------------------------------- */

function readQueryEmail(url) {
  const raw = url.searchParams.get('e');
  if (raw === null) return '';

  // URLSearchParams decodes "+" as a space, but a raw "+" in a query string is
  // how plus-addressed links usually arrive. Spaces are never valid in an
  // unquoted address, so restoring them is unambiguous.
  return raw.replace(/ /g, '+');
}

async function readSubmittedEmail(request) {
  const contentType = request.headers.get('Content-Type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      const body = await request.json();
      return typeof body?.email === 'string' ? body.email : '';
    }

    const form = await request.formData();
    const value = form.get('email');
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function normalizeEmail(value) {
  return (value ?? '').trim().toLowerCase();
}

function isValidEmail(email) {
  if (!email || email.length > MAX_EMAIL_LENGTH) return false;
  return /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\]+\.[^\s@,;:<>"'\\]{2,}$/.test(email);
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function methodNotAllowed(allow) {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: allow, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                      */
/* -------------------------------------------------------------------------- */

function renderConfirmPrompt(email) {
  return htmlResponse(
    layout({
      title: 'Unsubscribe',
      body: `
        <p class="section-label">Unsubscribe</p>
        <h1>Stop hearing from us?</h1>
        <p class="lede">We'll remove this address from our outreach list. No account needed, and nothing else about you is recorded.</p>

        <div class="address">${escapeHtml(email)}</div>

        <form method="POST" action="/unsubscribe">
          <input type="hidden" name="email" value="${escapeHtml(email)}" />
          <button type="submit" class="btn-primary">Confirm unsubscribe</button>
        </form>

        <p class="footnote">Not your address? <a href="/unsubscribe">Enter a different one</a>.</p>
      `,
    })
  );
}

function renderManualEntry({ error = '', value = '', status = 200 } = {}) {
  return htmlResponse(
    layout({
      title: 'Unsubscribe',
      body: `
        <p class="section-label">Unsubscribe</p>
        <h1>Which address should we remove?</h1>
        <p class="lede">We couldn't read an email address from your link. Enter it below and we'll take it off our outreach list.</p>

        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}

        <form method="POST" action="/unsubscribe">
          <label class="field-label" for="email">Email address</label>
          <input
            type="email"
            id="email"
            name="email"
            class="field"
            value="${escapeHtml(value)}"
            placeholder="you@example.com"
            autocomplete="email"
            autocapitalize="off"
            spellcheck="false"
            required
          />
          <button type="submit" class="btn-primary">Confirm unsubscribe</button>
        </form>
      `,
    }),
    status
  );
}

function renderConfirmed(email) {
  return htmlResponse(
    layout({
      title: 'Unsubscribed',
      body: `
        <p class="section-label">Unsubscribed</p>
        <h1>You're off the list.</h1>

        <div class="address">${escapeHtml(email)}</div>

        <p class="lede">This address won't receive any further outreach from us. We haven't sent a confirmation email — that would defeat the point.</p>

        <p class="footnote">Reached this by mistake? Email <a href="mailto:info@fiddyfiddy.org">info@fiddyfiddy.org</a> and we'll sort it out.</p>
      `,
    })
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Same type scale, palette, and chrome as public/index.html, inlined so the
 * page renders in one round trip with no shared stylesheet to keep in sync.
 */
function layout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(title)} — Fiddyfiddy</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:       #0d0f10;
      --bg2:      #141618;
      --bg3:      #1c1f22;
      --border:   #2a2d31;
      --text:     #e8e6e0;
      --muted:    #9a9890;
      --accent:   #d4f04e;
      --accent2:  #b8d43a;
      --white:    #f5f3ed;
      --radius:   10px;
      --mono:     'DM Mono', monospace;
      --sans:     'DM Sans', sans-serif;
    }

    body {
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      font-size: 17px;
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    a { color: inherit; text-decoration: none; }

    nav {
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      padding: 0 2rem;
      display: flex; align-items: center;
      height: 60px;
    }
    .nav-logo {
      font-family: var(--mono);
      font-size: 15px;
      font-weight: 500;
      letter-spacing: 0.04em;
      color: var(--accent);
    }

    main {
      flex: 1;
      width: 100%;
      max-width: 560px;
      margin: 0 auto;
      padding: 80px 2rem;
    }

    .section-label {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 1rem;
    }

    h1 {
      font-size: clamp(1.8rem, 4vw, 2.4rem);
      font-weight: 300;
      color: var(--white);
      line-height: 1.25;
      letter-spacing: -0.01em;
      margin-bottom: 1rem;
    }

    .lede {
      font-size: 17px;
      color: var(--muted);
      line-height: 1.65;
      margin-bottom: 2rem;
    }

    .address {
      font-family: var(--mono);
      font-size: 15px;
      color: var(--white);
      background: var(--bg2);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--radius);
      padding: 1.1rem 1.25rem;
      margin-bottom: 2rem;
      word-break: break-all;
    }

    .error {
      font-size: 15px;
      color: var(--white);
      background: var(--bg2);
      border: 1px solid var(--border);
      border-left: 3px solid #e0644e;
      border-radius: var(--radius);
      padding: 0.9rem 1.25rem;
      margin-bottom: 1.5rem;
    }

    .field-label {
      display: block;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.6rem;
    }

    .field {
      width: 100%;
      font-family: var(--sans);
      font-size: 16px;
      color: var(--text);
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px 14px;
      margin-bottom: 1.5rem;
      transition: border-color 0.15s;
    }
    .field::placeholder { color: #63615c; }
    .field:focus {
      outline: none;
      border-color: var(--accent);
    }

    .btn-primary {
      display: inline-block;
      font-family: var(--sans);
      background: var(--accent);
      color: #0d0f10;
      font-size: 15px;
      font-weight: 500;
      padding: 13px 28px;
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-primary:hover { background: var(--accent2); }

    .footnote {
      font-size: 14px;
      color: var(--muted);
      margin-top: 2rem;
    }
    .footnote a {
      color: var(--accent);
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s;
    }
    .footnote a:hover { border-color: var(--accent); }

    footer {
      padding: 2.5rem 2rem;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
      max-width: 960px;
      width: 100%;
      margin: 0 auto;
    }
    .footer-logo {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--accent);
    }
    .footer-right {
      font-size: 13px;
      color: var(--muted);
      text-align: right;
      line-height: 1.8;
    }
    .footer-right a {
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      transition: color 0.15s;
    }
    .footer-right a:hover { color: var(--text); }

    @media (max-width: 640px) {
      nav { padding: 0 1.25rem; }
      main { padding: 60px 1.25rem; }
      footer { padding: 2rem 1.25rem; flex-direction: column; text-align: center; }
      .footer-right { text-align: center; }
    }
  </style>
</head>
<body>

<nav>
  <a href="/" class="nav-logo">fiddyfiddy</a>
</nav>

<main>
${body}
</main>

<footer>
  <span class="footer-logo">fiddyfiddy</span>
  <div class="footer-right">
    <a href="https://fiddyfiddy.org">fiddyfiddy.org</a> &nbsp;·&nbsp;
    <a href="mailto:info@fiddyfiddy.org">info@fiddyfiddy.org</a><br/>
    © 2026 Fiddyfiddy
  </div>
</footer>

</body>
</html>`;
}

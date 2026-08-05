# fiddyfiddy.org

Marketing site for Fiddyfiddy, plus the outreach unsubscribe endpoint. Deployed
as a Cloudflare Worker (`fiddywebsite`), with `fiddyfiddy.org` routed to it.

```
public/           static site — served directly by the edge
  index.html
  organizer-guide.html
  simulator.html
src/worker.js     /unsubscribe and /api/suppressions
schema.sql        D1 table definition
```

Paths that match a file in `public/` never invoke the Worker.

## Endpoints

### `GET /unsubscribe?e=<email>`

Shows the address and a confirm button. Nothing is recorded on GET, so mail
client link prefetchers and security scanners can't suppress an address by
following the link.

A missing or malformed `e` falls back to a manual entry field rather than an
error page.

### `POST /unsubscribe`

Form-encoded or JSON `email`. Records the opt-out and shows a confirmation.
Idempotent — re-submitting an already-suppressed address succeeds silently.

No login, no email sent, and nothing stored beyond the address, the timestamp,
and `source = "operator-outreach"`.

### `GET /api/suppressions`

For the outreach sender to sync. Requires a bearer token:

```bash
curl -H "Authorization: Bearer $SUPPRESSIONS_API_TOKEN" \
  https://fiddyfiddy.org/api/suppressions
```

```json
{
  "count": 1,
  "generated_at": "2026-08-04T15:00:00.000Z",
  "suppressions": [
    {
      "email": "someone@example.com",
      "suppressed_at": "2026-08-04T14:59:00.000Z",
      "source": "operator-outreach"
    }
  ]
}
```

If `SUPPRESSIONS_API_TOKEN` is unset the endpoint returns 503 — it never falls
back to serving the list unauthenticated.

## First-time setup

The D1 database has to exist before the first deploy, or `wrangler deploy`
fails on the unresolved binding.

```bash
npm install

# 1. Create the database, then paste the printed id into wrangler.jsonc
#    in place of REPLACE_WITH_D1_DATABASE_ID.
npx wrangler d1 create fiddy-suppressions

# 2. Create the table.
npm run db:init

# 3. Set the API token (generate one with: openssl rand -base64 32).
npx wrangler secret put SUPPRESSIONS_API_TOKEN

# 4. Deploy.
npm run deploy
```

## Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:init:local
npm run dev
```

`wrangler dev` uses a local SQLite file, so local opt-outs never touch the
production list.

## Inspecting the list

```bash
npx wrangler d1 execute fiddy-suppressions --remote \
  --command "SELECT * FROM suppressions ORDER BY suppressed_at DESC LIMIT 20"
```

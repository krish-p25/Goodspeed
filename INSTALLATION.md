# Installation & Development Setup

This guide walks you through cloning the project from GitHub and running it in
development mode on your machine.

The project is a Turborepo monorepo with two apps:

| App        | Workspace  | Dev port | What it is                     |
| ---------- | ---------- | -------- | ------------------------------ |
| Web        | `@kb/web`  | `3020`   | Next.js frontend (App Router)  |
| API        | `@kb/api`  | `3010`   | NestJS backend                 |

Both apps read configuration from a **single `.env` file at the repository
root**, and the API uses a Supabase (Postgres + pgvector) database.

---

## 1. Prerequisites

Install these before you begin:

- **Node.js 22 or 24 (LTS recommended — Node 18 reached end-of-life April 2025) — check with `node -v`
- **npm ≥ 9** — bundled with Node; check with `npm -v`
- **Git** — to clone the repository
- **A Supabase project** — free tier is fine. Create one at
  [supabase.com](https://supabase.com). You will need its URL, API keys, and
  database password.
- **An LLM provider API key** — by default the project uses **OpenAI**
  (chat + embeddings). You can swap providers later via
  `apps/api/ai.config.json` (see [step 5](#5-configure-the-ai-provider-optional)).

> The Supabase CLI does **not** need a separate global install — it ships as a
> project dependency and is run through `npx supabase …`.

---

## 2. Clone the repository

```bash
git clone https://github.com/krish-p25/Goodspeed.git
cd Goodspeed
```

---

## 3. Install dependencies

From the repository root, install all workspaces in one command:

```bash
npm run setup
```

(`npm run setup` is an alias for `npm install`; npm workspaces installs the
root, both apps, and the shared `packages/*` together.)

---

## 4. Configure environment variables

Both apps load the **same `.env` file at the repository root**
(the web app via `--env-file=../../.env`, the API via `dotenv`). Create it:

```bash
cp .env.example .env   # if .env.example is present in your clone
```

### Where to find the Supabase values

In your Supabase project dashboard:

- **`NEXT_PUBLIC_SUPABASE_PROJECT_REF`** — your project **ref**: the subdomain
  of the Project URL under Project Settings → API. For
  `https://abcdxyz.supabase.co` the ref is `abcdxyz`. The full REST URL and the
  auth JWKS endpoint are derived from this automatically in code, so you don't
  configure them separately.
- **`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`** — Project Settings → API →
  *Publishable* (client-side, RLS-scoped) key
- **`SUPABASE_SECRET_KEY`** — Project Settings → API → *Secret* (server-only)
  key

> ⚠️ **Security:** `SUPABASE_SECRET_KEY` bypasses Row-Level Security. Keep it
> server-side only — never expose it to the browser, never prefix it with
> `NEXT_PUBLIC_`, and never commit your `.env`. Only `NEXT_PUBLIC_*` variables
> are sent to the client.

---

## 5. Set up the database

The database schema lives in committed migration files under
`supabase/migrations/`. Apply them to your Supabase project with the Supabase
CLI.

```bash
# 1. Authenticate the CLI (opens a browser to create an access token)
npx supabase login

# 2. Link this repo to your Supabase project.
#    <project-ref> is the subdomain of your project URL:
#    https://<project-ref>.supabase.co
#    You will be prompted for the database password.
npx supabase link --project-ref <project-ref>

# 3. Push all migrations to your project (creates tables, pgvector, RLS, etc.)
npx supabase db push
```

After the push, the `documents`, `chunks`, `conversations`, `messages`,
`message_sources`, and `token_usage` tables (plus the `match_chunks` function)
will exist in your project with Row-Level Security enabled.

> All schema changes are made through migration files only — do not edit the
> schema in the Supabase dashboard SQL editor, or your local migrations will
> drift from the remote database.

---

## 6. Configure the AI provider (optional)

With the dev server running, open the app and go to the **Settings page**
(linked from the dashboard header). Select your provider, enter your model,
and click Save. Changes take effect on the next request — no restart needed.

The project ships with OpenAI as the default provider. The only prerequisite
is that the matching API key is present in `.env` (e.g. `OPENAI_API_KEY`).
Adding or changing a key requires a restart — everything else is configurable
live from the Settings page.

> If you change the **embedding model** to one with a different vector
> dimension than the current `1536`, you will need a new migration — the
> `chunks.embedding` column dimension is fixed at the schema level.

For all supported providers and manual configuration options, see
[HOW_TO_SWAP_AI_PROVIDERS.md](./HOW_TO_SWAP_AI_PROVIDERS.md).

---

## 7. Run in development mode

From the repository root, start **both** apps together with Turborepo:

```bash
npm run dev
```

This runs each app in watch mode:

- **Web:** http://localhost:3020/login
- **API:** http://localhost:3010

Open **http://localhost:3020/login** in your browser, sign up / log in, and you're
running.

### Running a single app

```bash
npm run dev --workspace=@kb/web   # frontend only
npm run dev --workspace=@kb/api   # backend only
```

---

## 8. Verify it's working

- **API health:** `curl http://localhost:3010/health` → `{"status":"ok"}`
- **Web:** http://localhost:3020 loads the login page
- After logging in, create a document, then open **Chat** and ask a question
  about it — you should get an answer with citation badges.

---

## Available scripts

Run from the repository root:

| Command          | Description                                       |
| ---------------- | ------------------------------------------------- |
| `npm run setup`  | Install all dependencies                          |
| `npm run dev`    | Start both apps in watch mode (Turborepo)         |
| `npm run build`  | Build all workspaces                              |
| `npm run lint`   | Lint all workspaces                               |

Supabase CLI (run from the repository root):

| Command                                      | Description                          |
| -------------------------------------------- | ------------------------------------ |
| `npx supabase db push`                       | Apply pending migrations to remote   |
| `npx supabase migration list`                | Compare local vs remote migrations   |

---

## Troubleshooting

**`EADDRINUSE: address already in use :::3010` (or `:3020`)**
Another process is using the port. Either stop it, or change `PORT` / `WEB_PORT`
in `.env` (and update `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SITE_URL` /
`CORS_ORIGIN` to match).

**Web app can't reach the API / CORS errors**
Make sure both apps are running, that `NEXT_PUBLIC_API_URL` points at the API
port, and that `CORS_ORIGIN` matches the web origin (`http://localhost:3020`).

**`401 Unauthorized` on API calls**
Check the Supabase variables in `.env` — in particular
`NEXT_PUBLIC_SUPABASE_PROJECT_REF` must be your real project ref (the URL and
JWKS endpoint are derived from it), and the publishable key must be correct.

**Changes to `.env` not taking effect**
Environment variables are read at process start. Stop and restart
`npm run dev` after editing `.env`. (Changes to `apps/api/ai.config.json` are
the exception — they apply on the next request without a restart.)

**Migration push fails to connect**
Re-run `npx supabase login`, confirm the project ref in
`npx supabase link --project-ref <ref>`, and that you entered the correct
database password.

**AI requests fail with an authentication error**
The API key for the provider selected in `apps/api/ai.config.json` is missing or
wrong in `.env`. Set the correct key and restart.

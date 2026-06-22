# Phase 0 — Foundation & Scaffolding

> **For Claude Code:** This is an executable build brief. Work through it in order. Do **not** skip ahead — each section ends with a verification gate that must pass before continuing. If a command fails, stop and report rather than working around it. Do not add features beyond what is described here; later phases handle them.

## Context

This is the first phase of an "AI-Powered Knowledge Base" (a full-stack RAG application). Phase 0 produces **only the empty, runnable monorepo skeleton** — no auth, no database tables, no features. The goal is a repo a new developer can clone, run one setup command, and have both apps start.

**Tech stack (fixed — do not substitute):**

| Layer        | Technology                          |
| ------------ | ----------------------------------- |
| Monorepo     | Turborepo                           |
| Package mgr  | npm (use npm workspaces)            |
| Frontend     | React + Next.js (App Router)        |
| Backend API  | NestJS                              |
| Database     | Supabase (Postgres + pgvector)      |
| Language     | TypeScript throughout               |

> Phase 0 sets up the Supabase **project connection and env wiring only**. Do **not** create any tables, migrations, or RLS policies — that is Phase 1.

## Target structure

```
.
├── apps/
│   ├── web/                  # Next.js frontend (App Router)
│   └── api/                  # NestJS backend
├── packages/
│   ├── config/               # shared tsconfig, eslint config
│   └── types/                # shared TypeScript types + Zod schemas (empty placeholder for now)
├── .env.example              # every env var, documented
├── .gitignore
├── package.json              # root, workspace scripts + workspaces array
├── turbo.json
└── README.md                 # minimal for now; expanded at submission
```

---

## Step 1 — Initialise the repo and workspace

> **Note:** Steps 1 below is already completed by the manual-init step that
> created the skeleton. It is documented here for completeness; verify it matches
> rather than recreating it.

1. Git repo initialised.
2. Root `package.json` has `"private": true` and a `"workspaces"` array listing
   `"apps/*"` and `"packages/*"`. (npm declares workspaces inline in
   `package.json` — there is no separate workspace file.)
3. Turborepo is a root dev dependency.

**Gate:** `npm install` completes without error and `npx turbo --version` prints a version.

---

## Step 2 — Shared packages

Create the two shared packages first, because the apps will extend their config.

### `packages/config`
- A base `tsconfig.base.json` with strict mode on (`"strict": true`), sensible module/target settings for Node + Next.
- A shared ESLint flat config that both apps extend.
- `package.json` named `@kb/config`, exporting these files.

### `packages/types`
- `package.json` named `@kb/types`.
- A single `src/index.ts` that for now just exports a placeholder (e.g. `export const PLACEHOLDER = true;`). Real DTOs and Zod schemas come in later phases — do not invent them now.
- Zod as a dependency (it will be used later).
- A `tsconfig.json` extending `@kb/config`.

**Gate:** `npm run build --workspace=@kb/types` and `npm install --workspace=@kb/config` resolve without error.

---

## Step 3 — `apps/api` (NestJS)

1. Scaffold a standard NestJS application in `apps/api`.
2. `package.json` named `@kb/api`. Add `@kb/types` and `@kb/config` as workspace dependencies (version `"*"`, which npm resolves to the local workspace package).
3. `tsconfig.json` extends `@kb/config`.
4. Add a single health endpoint: `GET /health` returning `{ "status": "ok" }`. Nothing else.
5. Configure it to read a `PORT` env var (default `3001`) and enable CORS for the web app's origin.
6. Scripts: `dev` (watch mode), `build`, `lint`, `start`.

**Gate:** `npm run dev --workspace=@kb/api` starts the server and `curl http://localhost:3001/health` returns `{"status":"ok"}`.

---

## Step 4 — `apps/web` (Next.js)

1. Scaffold a Next.js app (App Router, TypeScript, Tailwind) in `apps/web`.
2. `package.json` named `@kb/web`. Add `@kb/types` and `@kb/config` as workspace dependencies (version `"*"`).
3. `tsconfig.json` extends `@kb/config`.
4. Replace the default landing page with a minimal page that fetches `GET /health` from the API and displays the status — this proves the web→api wire works. Read the API base URL from `NEXT_PUBLIC_API_URL`.
5. Configure it to run on `PORT` `3000`.
6. Scripts: `dev`, `build`, `lint`, `start`.

**Gate:** `npm run dev --workspace=@kb/web` starts the app, and visiting `http://localhost:3000` shows the API health status as `ok` (both apps must be running).

---

## Step 5 — Turborepo pipelines

Create `turbo.json` with tasks for `dev`, `build`, and `lint`:

- `build`: `"dependsOn": ["^build"]`, with `outputs` set correctly for Next (`.next/**`, excluding cache) and Nest (`dist/**`).
- `dev`: `"cache": false`, `"persistent": true`.
- `lint`: no outputs, may depend on `^build` if types are needed.

Add root `package.json` scripts that proxy to turbo:
- `"dev": "turbo run dev"`
- `"build": "turbo run build"`
- `"lint": "turbo run lint"`

**Gate:** From the repo root, `npm run dev` starts **both** apps together, and `npm run build` builds everything with Turbo caching working (a second `build` run reports cache hits).

---

## Step 6 — Environment variables

Create `.env.example` documenting **every** variable the project will need across all phases, each with a comment. Use placeholder values, never real secrets. Include at minimum:

```dotenv
# ---- App ----
# Web app origin and API URL
NEXT_PUBLIC_API_URL=http://localhost:3001
PORT=3001                      # API port (web defaults to 3000)

# ---- Supabase ----
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key            # client-side, RLS-scoped
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key   # server-only, bypasses RLS — never expose to client
SUPABASE_JWT_SECRET=your-jwt-secret        # for verifying auth tokens in the API

# ---- AI: Chat provider (OpenAI-spec compatible) ----
CHAT_PROVIDER_BASE_URL=https://api.openai.com/v1
CHAT_PROVIDER_API_KEY=your-key
CHAT_MODEL=gpt-4o-mini

# ---- AI: Embedding provider (OpenAI-spec compatible) ----
# NOTE: embedding dimension is fixed at the DB schema level (Phase 1).
# Changing embedding model/dimension requires a migration.
EMBED_PROVIDER_BASE_URL=https://api.openai.com/v1
EMBED_PROVIDER_API_KEY=your-key
EMBED_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536

# ---- Retrieval (tunable) ----
RETRIEVAL_TOP_K=5
RETRIEVAL_SIMILARITY_THRESHOLD=0.35   # cosine similarity floor
CONVERSATION_HISTORY_WINDOW=6         # last N messages carried into prompt
```

Also create a `.gitignore` covering `node_modules`, `.env`, `.env.local`, `.next`, `dist`, `.turbo`, and OS/editor cruft. **Ensure `.env` is ignored; only `.env.example` is committed.**

**Gate:** `.env.example` exists and is committed; `.env` is git-ignored.

---

## Step 7 — Single setup command

Add a root script so a new developer can get running in one command. At minimum it installs dependencies; document the full first-run sequence in the README. For example:

- `"setup": "npm install"` (extend later when migrations exist in Phase 1).

In the README "Getting Started", document the real first-run flow:
1. `cp .env.example .env` and fill in values
2. `npm run setup`
3. `npm run dev`

**Gate:** Following the README from a fresh clone (simulate by removing `node_modules` and re-running) brings both apps up.

---

## Step 8 — Minimal README

Create a `README.md` with: project one-liner, the tech-stack table, prerequisites (Node version, npm, a Supabase project), the Getting Started steps from Step 7, and a "Project structure" section. Leave clearly-marked TODO placeholders for the sections required at submission (architecture decisions, how to swap AI providers, future improvements, Loom links) — these are filled in later phases.

---

## Phase 0 completion checklist

Before declaring Phase 0 done, confirm **all** of these:

- [ ] `npm install` from a clean clone succeeds
- [ ] `npm run dev` starts both `@kb/web` (:3000) and `@kb/api` (:3001)
- [ ] The web landing page successfully reads `/health` from the API and shows `ok`
- [ ] `npm run build` succeeds for all workspaces; re-running shows Turbo cache hits
- [ ] `npm run lint` runs across all workspaces
- [ ] `packages/types` and `packages/config` are consumed by both apps via the `"*"` workspace version
- [ ] `.env.example` documents every variable; `.env` is git-ignored
- [ ] README Getting Started works from a fresh clone

**Do not begin Phase 1 (database schema, migrations, RLS) until every box above is checked.** Report the completed checklist back before proceeding.

---

## Explicitly out of scope for Phase 0

Do not implement any of the following now — they belong to later phases:
- Database tables, migrations, pgvector, or RLS policies (Phase 1)
- Supabase Auth, login UI, or the NestJS auth guard (Phase 2)
- Document CRUD (Phase 3)
- The AI provider abstraction (Phase 4)
- Any embedding, chunking, retrieval, or chat logic (Phases 5–9)

Keep Phase 0 strictly to a clean, runnable, empty skeleton.

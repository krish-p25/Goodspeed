# AI-Powered Knowledge Base

A full-stack RAG (Retrieval Augmented Generation) application where users
create and manage documents, then ask questions about them through an AI
chat interface that retrieves relevant context and grounds its answers in
their own content.

Built for the Goodspeed Software Developer Technical Assessment.

---

## Loom walkthroughs

- [App walkthrough](#) — feature demo, end to end
- [AI acceleration walkthrough](#) — how AI was used throughout the build

---

## Tech stack

| Layer       | Technology                              |
|-------------|-----------------------------------------|
| Monorepo    | Turborepo                               |
| Frontend    | Next.js (App Router) + Tailwind + shadcn/ui |
| Backend API | NestJS                                  |
| Database    | Supabase (PostgreSQL + pgvector)        |
| Auth        | Supabase Auth                           |
| AI          | OpenAI SDK (provider-agnostic — see below) |

---

## Getting started

For the full step-by-step setup guide including environment variables,
database migrations, troubleshooting, and available scripts, see
[INSTALLATION.md](./INSTALLATION.md).

Quick summary:

```bash
git clone https://github.com/krish-p25/Goodspeed.git
cd Goodspeed
npm run setup          # install all workspaces
cp .env.example .env   # set your Supabase project ref + keys and AI provider keys
npx supabase login
npx supabase link --project-ref <your-project-ref>   # same ref as in .env
npx supabase db push   # applies schema, RLS, and match_chunks function
npm run dev            # starts web (:3020) and API (:3010)
```

Once running, go to the **Settings page** (linked from the dashboard header)
to configure your AI provider and model. Changes take effect immediately —
no restart needed.

---

## How to swap AI providers

Switching providers takes effect on the next request — no restart needed.

**Via the settings page (recommended):** with the dev server running, open
the app in your browser and navigate to the Settings page (linked from the
dashboard header). Select a provider, adjust the model if needed, and click
Save.

**Via ai.config.json directly:** edit `apps/api/ai.config.json` and save.

| Provider    | chat.provider | chat.baseUrl                         | Recommended model                    |
|-------------|---------------|--------------------------------------|--------------------------------------|
| OpenAI      | `openai`      | `https://api.openai.com/v1`          | `gpt-4.1-mini`                       |
| Groq        | `groq`        | `https://api.groq.com/openai/v1`     | `openai/gpt-oss-20b`                 |
| Together AI | `together`    | `https://api.together.xyz/v1`        | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| Ollama      | `ollama`      | `http://localhost:11434/v1`          | `llama3.2`                           |
| Mock        | `mock`        | *(leave empty)*                      | *(leave empty)*                      |

> Groq and Together AI do not offer embedding models. Keep the `embedding`
> block on OpenAI when using either for chat.

> The embedding model is coupled to the database schema (`vector(1536)`
> for `text-embedding-3-small`). Changing the embedding model to one that
> produces a different vector dimension requires a database migration.

For the full provider swap guide including all supported configurations and
instructions for adding a new provider, see
[HOW_TO_SWAP_AI_PROVIDERS.md](./HOW_TO_SWAP_AI_PROVIDERS.md).

---

## Architecture decisions

The system is built around several deliberate design decisions. Full rationale,
options considered, and trade-offs for each decision are documented in
[ARCHITECTURE_DECISIONS.md](./ARCHITECTURE_DECISIONS.md). Key decisions
summarised here:

**Monorepo — thin shared packages.** `packages/` contains only TypeScript
types and config. Runtime logic stays in its app because the two apps have
fundamentally different initialisation requirements.

**BFF pattern with RLS.** All data traffic routes through the NestJS API.
The API creates a request-scoped Supabase client carrying the user's JWT so
Postgres Row Level Security enforces data isolation at the database layer —
defence in depth beyond application-level query logic.

**Provider-agnostic AI layer.** A clean `LLMProvider` interface with
project-owned types decouples the application from the OpenAI SDK, which
is quarantined to a single adapter file. The adapter is built on Chat
Completions (not OpenAI's newer Responses API) because Chat Completions is
the only standard all alternative providers implement. Provider switching is
hot-swappable via `ai.config.json` with no server restart.

**pgvector with HNSW index.** HNSW was chosen over IVFFlat because it
requires no pre-training step and produces good recall from the first
insert. Similarity queries are wrapped in a Postgres function called via
`rpc()` because PostgREST does not support pgvector operators directly.
User scoping is applied inside the SQL function rather than as a chained
filter so the vector planner can use the index during traversal.

**Strict grounding prompt.** The model is instructed to answer only from
the provided context and decline when context is insufficient. When
retrieval returns nothing, the LLM call is skipped entirely — instant,
deterministic, and costs nothing.

**Span-level citations.** A buffering stream resolver intercepts citation
markers mid-stream, validates them against a sentence map built at
retrieval time, and emits them as highlighted spans in the UI. Invalid
IDs are silently dropped. Document-level sources remain the guaranteed
floor regardless of whether sentence-level markers resolve.

---

## What I would improve or add given more time

The full list with detail on each item is in
[FUTURE_IMPROVEMENTS.md](./FUTURE_IMPROVEMENTS.md). The most significant
items:

- **Team collaboration and permissions** — workspace model with role-based
  access (viewer, editor, admin) and updated RLS policies scoped to
  workspace membership rather than individual user.
- **Citation click-through** — clicking a citation navigates to the source
  document and auto-scrolls to the cited sentence with text highlighted.
  The `char_start` and `char_end` offsets are already persisted in
  `message_sources`; the remaining work is the frontend scroll-to-highlight
  behaviour.
- **Two-factor authentication** — TOTP via an authenticator app on top of
  the existing Supabase Auth email/password flow.
- **Query rewriting** — condensing conversation history and follow-up
  questions into a standalone search query before embedding, improving
  retrieval quality on multi-turn conversations.
- **Async embedding** — moving embedding generation to a background queue
  so document saves respond instantly rather than blocking on embedding API
  calls.
- **Hybrid search** — combining vector similarity with Postgres full-text
  search to improve recall for queries containing exact terms or proper
  nouns.
- **API key management from settings** — securely configuring provider keys
  from the UI rather than requiring server environment variable access.

---

## Project structure

```
ai-knowledge-base/
├── apps/
│   ├── web/          # Next.js frontend (App Router)
│   └── api/          # NestJS backend
├── packages/
│   ├── config/       # Shared tsconfig and eslint config
│   └── types/        # Shared TypeScript types and Zod schemas
├── supabase/
│   └── migrations/   # SQL migration files
├── ai.config.json    # AI provider behaviour config (committed, no secrets)
├── .env.example      # Environment variable reference
└── turbo.json        # Turborepo pipeline config
```

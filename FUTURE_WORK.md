# What I Would Improve or Add Given More Time

---

## Team collaboration on documents

Currently the knowledge base is strictly single-user — every document,
conversation, and embedding is scoped to the authenticated user via Row
Level Security. Given more time I would add the concept of a workspace
shared between multiple users, where documents can be created and edited
collaboratively. This would involve a workspaces table, workspace
membership, and updated RLS policies scoping data to workspace membership
rather than individual user ID.

## Permission system for team collaboration

Alongside workspace collaboration, a role-based permission system would
control what each member can do — for example, viewer (read-only chat
access), editor (can create and edit documents), and admin (can manage
members and workspace settings). This maps to Postgres roles and RLS
policies and would integrate naturally with the existing auth layer.

## Citation click-through — open document and scroll to highlighted text

Currently clicking a citation shows a hover tooltip with the source
sentence. The natural next step is making the citation clickable —
navigating to the source document and auto-scrolling to the exact sentence
with the cited text highlighted. The data to support this already exists:
message_sources stores char_start and char_end offsets into the document
content. The remaining work is passing those offsets to the document editor
and implementing scroll-to-highlight behaviour on the markdown editor.

## Two-factor authentication

The current auth implementation uses email and password only via Supabase
Auth. Adding 2FA — TOTP via an authenticator app — would be a natural
security improvement, especially for a workspace product where multiple
users share access to a knowledge base.

## API key management from the settings page

Currently API keys must be set as server environment variables and require
a restart to change. A secure key management UI would allow providers to
be fully configured from the settings page without server access. The
correct implementation would encrypt keys before storage and write them to
a secrets store rather than plain environment variables.

## Cost estimation

The token usage data is already persisted per call alongside the model
name. Given a per-model pricing table, the dashboard could show estimated
cost in addition to raw token counts — broken down by chat and embedding
spend per conversation. A natural extension of the existing usage view
with no schema changes required.

## Async embedding via background queue

Document embedding currently happens synchronously, blocking the HTTP
response until all chunks are embedded. Moving embedding to a background
queue — BullMQ, Supabase Edge Functions, or pg_cron — would make the
save response instant and process embeddings asynchronously, with a
visual indicator in the UI while the document becomes searchable.

## Hybrid search

The current retrieval is purely vector-based. Hybrid search — combining
vector similarity with keyword full-text search and merging the results —
would improve recall for queries containing exact terms or proper nouns
that embedding-based similarity can underweight. Supabase supports
full-text search natively alongside pgvector, making this a natural
extension of the existing retrieval layer.

## Dev-mode page compile times

First load of a route in development is noticeably slow. This affects the
development experience only — production builds are compiled ahead of time by
next build — but it slows iteration and is worth investigating properly. Next.js
compiles each route lazily on its first request in dev, so the cost is dominated
by the size of that route's client module graph, and a few very large libraries
inflate it: lucide-react (~38 MB on disk) is imported on every page, while
recharts with its d3 stack (~9 MB) and the @uiw/react-md-editor markdown and
syntax pipeline (~5 MB) weigh down the dashboard and document editor
respectively. There is currently no build tuning to mitigate this —
next.config.js is empty, so barrel imports are not collapsed via
optimizePackageImports, and dev runs on Turbopack, which was still beta in Next
14.2 and does not honour all of the webpack-side import optimizations. The
Tailwind v4 setup adds further overhead through a redundant @source glob and a
runtime shadcn CSS import. The fix would combine collapsing those barrel imports,
benchmarking Turbopack against webpack (or upgrading to Next 15 where Turbopack
dev is stable), keeping the heaviest libraries lazily loaded, and trimming the
Tailwind configuration.

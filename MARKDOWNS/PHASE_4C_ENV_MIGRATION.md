# Phase 4 — Environment Variable Migration

> **For Claude Code:** Read this before continuing with the Phase 4 hot-swap
> verification. The env var naming convention changed during planning. This
> note explains what to update before Step 10 can be verified.

---

## What changed

During Phase 4 planning, the AI provider key naming was updated. The original
doc referenced `CHAT_PROVIDER_API_KEY` and `EMBED_PROVIDER_API_KEY` as the
env vars for the real provider test. These have been replaced.

**Old (remove from .env and .env.example):**
```
CHAT_PROVIDER_API_KEY=...
EMBED_PROVIDER_API_KEY=...
```

**New (add to .env and .env.example):**
```
OPENAI_API_KEY=sk-...
```

## Why it changed

The original design had one key per *role* (chat, embed). The updated design
has one key per *provider service* (OpenAI, Groq, Together AI etc.). The
`AiConfigService.resolveApiKey()` method maps provider names to env var names
via a `keyMap`:

```
openai      → OPENAI_API_KEY
groq        → GROQ_API_KEY
together    → TOGETHER_API_KEY
openrouter  → OPENROUTER_API_KEY
ollama      → OLLAMA_API_KEY (optional, ignored at runtime)
```

The active key is determined by the `provider` field in the `chat` and
`embedding` blocks of `ai.config.json` — not by a hardcoded env var name.

## Actions required

1. **Remove** `CHAT_PROVIDER_API_KEY` and `EMBED_PROVIDER_API_KEY` from
   `.env` and `.env.example` if they are present.

2. **Add** the following to `.env` (real value) and `.env.example`
   (placeholder):

   ```dotenv
   # ---- AI provider API keys ----
   # One key per provider service. Which key is active is determined by
   # the provider field in apps/api/ai.config.json.
   # Only keys for providers you intend to use need real values.
   # Unused keys are never read. Changing a key requires a restart.
   OPENAI_API_KEY=sk-...
   GROQ_API_KEY=gsk-...
   TOGETHER_API_KEY=your-together-key
   OPENROUTER_API_KEY=your-openrouter-key
   # Ollama runs locally — no key needed
   ```

   In the real `.env`, only `OPENAI_API_KEY` needs a real value for now.
   Leave the others as placeholders.

3. **Verify `AiConfigService`** contains the keyMap as specified. If it was
   implemented using `CHAT_PROVIDER_API_KEY` or `EMBED_PROVIDER_API_KEY`,
   update `resolveApiKey()` to match this:

   ```typescript
   private resolveApiKey(provider: string): string {
     const keyMap: Record<string, string> = {
       openai: 'OPENAI_API_KEY',
       groq: 'GROQ_API_KEY',
       together: 'TOGETHER_API_KEY',
       openrouter: 'OPENROUTER_API_KEY',
       ollama: 'OLLAMA_API_KEY',
     }
     const envVar = keyMap[provider]
     if (!envVar) {
       throw new Error(
         `Unknown provider "${provider}". Add it to the keyMap in AiConfigService.`
       )
     }
     return this.config.get<string>(envVar) ?? 'ollama'
   }
   ```

4. **Confirm `npm run build --workspace=@kb/api` passes** after the update.

5. **Proceed with Step 10** (hot-swap verification) using `OPENAI_API_KEY`
   in `.env` and `ai.config.json` set to the openai provider block.

---

## Complete .env reference

For reference, here is the full set of env vars the project needs at this
point across all phases completed so far:

```dotenv
# ---- App ----
NEXT_PUBLIC_API_URL=http://localhost:3010
PORT=3010
WEB_PORT=3020
CORS_ORIGIN=http://localhost:3020

# ---- Supabase ----
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_JWKS_URL=https://your-project.supabase.co/auth/v1/.well-known/jwks.json

# ---- AI provider API keys ----
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk-...
TOGETHER_API_KEY=your-together-key
OPENROUTER_API_KEY=your-openrouter-key

# ---- Retrieval ----
RETRIEVAL_TOP_K=5
RETRIEVAL_SIMILARITY_THRESHOLD=0.35
CONVERSATION_HISTORY_WINDOW=6
```

No other vars are needed. If any old CHAT_PROVIDER_* or EMBED_PROVIDER_*
vars remain, remove them — they are no longer read anywhere in the codebase.

# How to Swap AI Providers

Switching providers requires editing one file and takes effect on the next
request — no restart needed. API keys are the only exception; they live in
`.env` and require a restart when changed.

---

## Option 1 — Settings page (recommended)

With the dev server running, open the app in your browser and navigate to
the Settings page (linked from the dashboard header). Select a provider
from the dropdown, adjust the model if needed, and click Save. Done.

---

## Option 2 — Edit ai.config.json directly

Open `apps/api/ai.config.json` and update the `chat.provider`,
`chat.baseUrl`, and `chat.model` fields. Save the file. The next request
uses the new provider.

**OpenAI**
```json
"chat": { "provider": "openai", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1-mini" }
```

**Groq** (use OpenAI for embeddings — Groq has no embedding models)
```json
"chat": { "provider": "groq", "baseUrl": "https://api.groq.com/openai/v1", "model": "openai/gpt-oss-20b" }
```

**Together AI** (use OpenAI for embeddings — Together AI has no embedding models)
```json
"chat": { "provider": "together", "baseUrl": "https://api.together.xyz/v1", "model": "meta-llama/Llama-3.3-70B-Instruct-Turbo" }
```

**Ollama** (local, no API key needed — run `ollama pull llama3.2` first)
```json
"chat": { "provider": "ollama", "baseUrl": "http://localhost:11434/v1", "model": "llama3.2" }
```

**Mock** (no API key, instant canned responses — useful for development)
```json
"chat": { "provider": "mock", "baseUrl": "", "model": "" }
```

---

## API keys

Add the key for each provider you intend to use to `.env`. Only the active
provider's key is read — unused keys are ignored.

```dotenv
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk-...
TOGETHER_API_KEY=...
# Ollama needs no key
```

Restart the server after changing `.env`.

---

## Embedding provider

The embedding provider is configured separately in the `embedding` block
of `ai.config.json` following the same pattern. Note: the database schema
is fixed at `vector(1536)` to match `text-embedding-3-small`. Switching to
a model that produces a different vector dimension requires a database
migration.

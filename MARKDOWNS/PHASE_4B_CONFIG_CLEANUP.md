# Phase 4 — AI Config Structure Cleanup

> **For Claude Code:** Apply this cleanup before Phase 5 begins. It is a
> small structural change to ai.config.json, ai.config.example.json, the
> AiConfig interface, and AiConfigService. No other files are affected.
> Confirm the build passes and the hot-swap still works before reporting done.

---

## What is changing and why

The top-level `provider` field in ai.config.json is being removed. It was
redundant — the block-level `chat.provider` and `embedding.provider` fields
already carry enough information to determine which adapter to use.
Removing the top-level field means the config has one level of provider
declaration, no ambiguity, and no repeated values.

**Old structure (remove top-level provider):**
```json
{
  "_comment": "...",
  "provider": "mock",
  "chat": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "embedding": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  }
}
```

**New structure (block-level provider only):**
```json
{
  "_comment": "Provider behaviour config. Change and save — takes effect on next request, no restart needed. API keys stay in .env and require a restart when changed.",
  "chat": {
    "provider": "mock",
    "baseUrl": "",
    "model": ""
  },
  "embedding": {
    "provider": "mock",
    "baseUrl": "",
    "model": ""
  }
}
```

The mock default is now expressed via `chat.provider: "mock"` rather than a
top-level field. `baseUrl` and `model` are empty strings when mock is active
— they are never read in the mock path so the values do not matter.

---

## Changes required

### 1. Update apps/api/ai.config.json

Replace the entire file with the new mock default:

```json
{
  "_comment": "Provider behaviour config. Change and save — takes effect on next request, no restart needed. API keys stay in .env and require a restart when changed.",
  "chat": {
    "provider": "mock",
    "baseUrl": "",
    "model": ""
  },
  "embedding": {
    "provider": "mock",
    "baseUrl": "",
    "model": ""
  }
}
```

### 2. Update apps/api/ai.config.example.json

Replace the entire file:

```json
{
  "_comment": "Copy the relevant block into ai.config.json to switch providers. No restart needed after saving.",

  "mock": {
    "chat": { "provider": "mock", "baseUrl": "", "model": "" },
    "embedding": { "provider": "mock", "baseUrl": "", "model": "" }
  },

  "openai": {
    "chat": {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini"
    },
    "embedding": {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "text-embedding-3-small"
    }
  },

  "groq_chat_openai_embed": {
    "chat": {
      "provider": "groq",
      "baseUrl": "https://api.groq.com/openai/v1",
      "model": "llama-3.1-8b-instant"
    },
    "embedding": {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "text-embedding-3-small"
    }
  },

  "ollama_local": {
    "chat": {
      "provider": "ollama",
      "baseUrl": "http://localhost:11434/v1",
      "model": "llama3.2"
    },
    "embedding": {
      "provider": "ollama",
      "baseUrl": "http://localhost:11434/v1",
      "model": "nomic-embed-text"
    }
  }
}
```

### 3. Update the AiConfig interface in ai-config.service.ts

Remove the top-level `provider` field:

```typescript
interface ProviderBlock {
  provider: string
  baseUrl: string
  model: string
}

interface AiConfig {
  chat: ProviderBlock
  embedding: ProviderBlock
}
```

### 4. Update AiConfigService.getProvider()

Check `chat.provider === 'mock'` instead of the top-level field:

```typescript
getProvider(): LLMProvider {
  const raw = fs.readFileSync(this.configPath, 'utf-8')
  const aiConfig: AiConfig = JSON.parse(raw)

  if (aiConfig.chat.provider === 'mock') {
    return new MockProvider()
  }

  return new OpenAICompatibleProvider({
    chatBaseUrl: aiConfig.chat.baseUrl,
    chatApiKey: this.resolveApiKey(aiConfig.chat.provider),
    chatModel: aiConfig.chat.model,
    embedBaseUrl: aiConfig.embedding.baseUrl,
    embedApiKey: this.resolveApiKey(aiConfig.embedding.provider),
    embedModel: aiConfig.embedding.model,
  })
}
```

---

## Verification

1. `npm run build --workspace=@kb/api` passes with no errors.

2. With ai.config.json set to mock (the new default above), confirm the
   mock provider still works:

```
GET http://localhost:3010/ai-test/chat
```
Expected: { "content": "This is a mock response from the AI provider." }

> Note: AiTestController was removed at the end of Phase 4. If it is no
> longer present, skip the endpoint test and confirm only that the build
> passes and the unit tests still pass:

```
npm run test --workspace=@kb/api
```

3. Commit the changes:

```
git add apps/api/ai.config.json apps/api/ai.config.example.json apps/api/src/ai/ai-config.service.ts
git commit -m "refactor: remove redundant top-level provider field from ai config"
```

**Gate:** Build passes, unit tests pass, changes committed. Report done and
await the Phase 5 doc.

# Phase 4 - AI Provider Abstraction

> **For Claude Code:** This is the highest-graded single phase of the
> assessment. Work carefully and precisely. Do not rush toward a working
> implementation at the cost of interface design quality — the evaluators
> are grading the abstraction layer, not just whether it works.
>
> Work through this in order. No UI is built in this phase — this is
> pure backend TypeScript. Stop at each verification gate and confirm it
> passes before continuing. Report the completion checklist at the end.

---

## Context

Phase 4 builds the provider-agnostic AI layer that every subsequent phase
depends on. The brief states: "We care about how you model this interface,
not just that it works with one provider."

**A critical architectural decision informed by the current API landscape:**

OpenAI introduced the Responses API (/v1/responses) in March 2025 as their
recommended path for new projects. However, the Responses API is OpenAI-
proprietary — Groq, Together AI, OpenRouter, Ollama, and all other
alternative providers implement the Chat Completions API
(/v1/chat/completions) only. Building the abstraction on the Responses API
would lock the project to OpenAI and defeat the provider-agnostic requirement
entirely. The correct decision is to build the adapter on Chat Completions,
which every OpenAI-compatible provider supports. Document this in the README.

**Hot-swappable provider config — no restart required:**

Provider behaviour (which provider, which model, which base URL) is stored
in a committed config file at apps/api/ai.config.json. The AiConfigService
reads and parses this file on every call, so changing the config file takes
effect on the next request with no app restart.

API keys live in .env, one key per provider service. The active key is
resolved from the provider name declared in ai.config.json — no key names
are hardcoded in config, no URL parsing, no ambiguity. Adding a new provider
means adding its key to .env and its config block to ai.config.json.

This gives a clean three-way separation:
- ai.config.json: which provider and model to use (committed, hot-swappable)
- .env: one API key per provider service (git-ignored, requires restart when changed)
- Application code: depends only on the LLMProvider interface (never changes)

**Two-layer interface design:**
- Layer 1: LLMProvider interface with project-owned types. No mention of
  the openai package anywhere. This is what the rest of the app depends on.
- Layer 2: OpenAICompatibleProvider adapter that implements LLMProvider
  using the openai npm SDK. The SDK is quarantined entirely inside this file.

**Chat and embedding providers are independently configurable.**
Each has its own provider/baseUrl/model block in ai.config.json and its own
API key in .env. A real deployment might use Groq for fast cheap chat and
OpenAI for embeddings simultaneously.

**A MockProvider is required.** It proves the abstraction is genuinely
swappable, gives you clean unit tests with no API calls, and is the safe
committed default so the project works out of the box without any keys.

---

## Step 1 - Install dependencies

### apps/api only

```
npm install openai --workspace=@kb/api
```

The openai package is installed in apps/api only. It must not be imported
anywhere outside of the adapter file. packages/ must not depend on it.

**Gate:** npm install completes. Confirm openai does NOT appear in
packages/types/package.json or packages/config/package.json.

---

## Step 2 - Create ai.config.json and ai.config.example.json

### apps/api/ai.config.json

This file is committed to git. It contains no secrets — only provider
behaviour config. The default uses the mock provider so the project works
out of the box without any API keys.

```json
{
  "_comment": "Provider behaviour config. Edit and save — takes effect on next request, no restart needed. API keys stay in .env and require a restart when changed.",
  "provider": "mock"
}
```

### apps/api/ai.config.example.json

Documents all supported configurations. Committed to git for reference.

```json
{
  "_comment": "Copy the relevant block into ai.config.json to switch providers. No restart needed after saving.",

  "mock": {
    "provider": "mock"
  },

  "openai": {
    "provider": "openai",
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
    "provider": "openai",
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
    "provider": "openai",
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

> Note on Ollama embeddings: nomic-embed-text produces 768-dimensional
> vectors. The database schema is fixed at vector(1536). Switching to Ollama
> for embeddings requires a migration to ALTER the chunks column dimension.
> The chat provider can be freely swapped at any time.

**Gate:** Both files created and valid JSON with no syntax errors.

---

## Step 3 - Add shared AI types to packages/types

Pure TypeScript — no dependency on the openai package. Both apps can import
these safely.

Add to packages/types/src/index.ts:

```typescript
// ---------------------------------------------------------------------------
// AI Provider domain types
// Pure TypeScript — no imports from the openai package.
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: MessageRole
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
}

export interface ChatResult {
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface ChatChunk {
  delta: string    // the new token text; may be empty string
  done: boolean    // true on the final chunk only
}

export interface TextEvent {
  type: 'text'
  delta: string
}

export interface CitationEvent {
  type: 'citation'
  ids: string[]
}

export type StreamEvent = TextEvent | CitationEvent
```

**Gate:** npm run build --workspace=@kb/types succeeds.

---

## Step 4 - The LLMProvider interface

Zero imports from the openai package — pure TypeScript contract.

### apps/api/src/ai/llm-provider.interface.ts

```typescript
import type { ChatMessage, ChatOptions, ChatResult, ChatChunk } from '@kb/types'

/**
 * LLMProvider — the core abstraction for all AI operations.
 *
 * This interface is owned by this project. The openai package is never
 * imported here. Adapters translate between these types and whatever SDK
 * they use internally.
 *
 * Chat and embedding are intentionally separate — they may be served by
 * different providers or models simultaneously, each configured
 * independently in ai.config.json.
 */
export interface LLMProvider {
  /**
   * Generate a chat completion. Resolves when the model finishes.
   * Use for non-streaming cases (background jobs, testing).
   */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>

  /**
   * Generate a streaming chat completion.
   * Yields ChatChunk objects as tokens arrive.
   * The final chunk will have done: true.
   */
  chatStream(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncGenerator<ChatChunk>

  /**
   * Generate embeddings for an array of text inputs.
   * Returns a parallel array of embedding vectors.
   * Vector length is fixed by the embedding model and must match the
   * database schema (1536 for text-embedding-3-small).
   */
  embed(texts: string[]): Promise<number[][]>
}

/**
 * NestJS injection token for LLMProvider.
 * Consuming services use @Inject(LLM_PROVIDER) — they never import a
 * concrete class. This is what makes the provider genuinely swappable.
 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER')
```

**Gate:** File created with no TypeScript errors.

---

## Step 5 - The OpenAICompatibleProvider adapter

The only file in the project that imports from the openai package.

### apps/api/src/ai/providers/openai-compatible.provider.ts

```typescript
import OpenAI from 'openai'
import type { LLMProvider } from '../llm-provider.interface'
import type { ChatMessage, ChatOptions, ChatResult, ChatChunk } from '@kb/types'

export interface OpenAICompatibleConfig {
  chatBaseUrl: string
  chatApiKey: string
  chatModel: string
  embedBaseUrl: string
  embedApiKey: string
  embedModel: string
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly chatClient: OpenAI
  private readonly embedClient: OpenAI
  private readonly chatModel: string
  private readonly embedModel: string

  constructor(config: OpenAICompatibleConfig) {
    // Separate clients so chat and embedding can point at different providers
    this.chatClient = new OpenAI({
      apiKey: config.chatApiKey,
      baseURL: config.chatBaseUrl,
    })
    this.embedClient = new OpenAI({
      apiKey: config.embedApiKey,
      baseURL: config.embedBaseUrl,
    })
    this.chatModel = config.chatModel
    this.embedModel = config.embedModel
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const response = await this.chatClient.chat.completions.create({
      model: this.chatModel,
      messages: messages.map(this.toSDKMessage),
      temperature: opts?.temperature,
      max_tokens: opts?.maxTokens,
      stream: false,
    })

    const choice = response.choices[0]
    return {
      content: choice.message.content ?? '',
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    }
  }

  async *chatStream(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const stream = await this.chatClient.chat.completions.create({
      model: this.chatModel,
      messages: messages.map(this.toSDKMessage),
      temperature: opts?.temperature,
      max_tokens: opts?.maxTokens,
      stream: true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      const done = chunk.choices[0]?.finish_reason != null
      yield { delta, done }
    }

    // Guarantee a terminal chunk — some providers omit the finish_reason chunk
    yield { delta: '', done: true }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.embedClient.embeddings.create({
      model: this.embedModel,
      input: texts,
    })

    // Sort by index — the API does not guarantee response order matches input
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding)
  }

  // Translate domain ChatMessage to the openai SDK type.
  // Private — no SDK types leak out of this file.
  private toSDKMessage(
    msg: ChatMessage,
  ): OpenAI.Chat.ChatCompletionMessageParam {
    return { role: msg.role, content: msg.content }
  }
}
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 6 - The MockProvider

### apps/api/src/ai/providers/mock.provider.ts

```typescript
import type { LLMProvider } from '../llm-provider.interface'
import type { ChatMessage, ChatOptions, ChatResult, ChatChunk } from '@kb/types'

export class MockProvider implements LLMProvider {
  private readonly chatResponse: string
  private readonly embeddingDimension: number

  constructor(opts?: { chatResponse?: string; embeddingDimension?: number }) {
    this.chatResponse =
      opts?.chatResponse ?? 'This is a mock response from the AI provider.'
    this.embeddingDimension = opts?.embeddingDimension ?? 1536
  }

  async chat(_messages: ChatMessage[], _opts?: ChatOptions): Promise<ChatResult> {
    return {
      content: this.chatResponse,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    }
  }

  async *chatStream(
    _messages: ChatMessage[],
    _opts?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const words = this.chatResponse.split(' ')
    for (const word of words) {
      yield { delta: word + ' ', done: false }
    }
    yield { delta: '', done: true }
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Deterministic non-zero vectors — index + 1 avoids zero-vector edge cases
    return texts.map((_, i) =>
      Array.from({ length: this.embeddingDimension }, () => (i + 1) * 0.01)
    )
  }
}
```

---

## Step 7 - AiConfigService

Reads ai.config.json on every call. Resolves the correct API key from .env
by matching against the provider name declared in the config — no URL
parsing, no hardcoded key names in the config file.

### apps/api/src/ai/ai-config.service.ts

```typescript
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as fs from 'fs'
import * as path from 'path'
import type { LLMProvider } from './llm-provider.interface'
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider'
import { MockProvider } from './providers/mock.provider'

interface ProviderBlock {
  provider: string
  baseUrl: string
  model: string
}

interface AiConfig {
  provider: 'openai' | 'mock'
  chat?: ProviderBlock
  embedding?: ProviderBlock
}

@Injectable()
export class AiConfigService {
  // Path is relative to apps/api — the NestJS process working directory
  private readonly configPath = path.resolve(process.cwd(), 'ai.config.json')

  constructor(private readonly config: ConfigService) {}

  /**
   * Returns the correct LLMProvider based on the current ai.config.json.
   * Re-reads the file on every call so provider switches take effect on
   * the next request with no app restart.
   *
   * API keys are resolved from .env by provider name — the config file
   * never contains secrets.
   */
  getProvider(): LLMProvider {
    const raw = fs.readFileSync(this.configPath, 'utf-8')
    const aiConfig: AiConfig = JSON.parse(raw)

    if (aiConfig.provider === 'mock') {
      return new MockProvider()
    }

    const chatBlock = aiConfig.chat ?? {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    }

    const embedBlock = aiConfig.embedding ?? {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
    }

    return new OpenAICompatibleProvider({
      chatBaseUrl: chatBlock.baseUrl,
      chatApiKey: this.resolveApiKey(chatBlock.provider),
      chatModel: chatBlock.model,
      embedBaseUrl: embedBlock.baseUrl,
      embedApiKey: this.resolveApiKey(embedBlock.provider),
      embedModel: embedBlock.model,
    })
  }

  /**
   * Resolves the API key for a given provider name from .env.
   * The mapping lives here — one place, explicit, no URL parsing.
   * To add a new provider: add its key to .env and add a case here.
   */
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

    // Ollama runs locally and ignores the API key entirely.
    // Fall back to the literal string 'ollama' which the SDK accepts.
    return this.config.get<string>(envVar) ?? 'ollama'
  }
}
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 8 - AiModule with Proxy pattern

The Proxy wraps the LLM_PROVIDER token so every method call on it
automatically delegates to the current provider from ai.config.json.
Consuming services never see AiConfigService — the hot-swap is fully
encapsulated in this module.

### apps/api/src/ai/ai.module.ts

```typescript
import { Module } from '@nestjs/common'
import { AiConfigService } from './ai-config.service'
import { LLM_PROVIDER } from './llm-provider.interface'

@Module({
  providers: [
    AiConfigService,
    {
      provide: LLM_PROVIDER,
      inject: [AiConfigService],
      useFactory: (aiConfigService: AiConfigService) => {
        // The Proxy intercepts every method call on the LLM_PROVIDER token
        // and delegates to whichever provider ai.config.json currently
        // specifies. Consuming services depend only on LLM_PROVIDER —
        // they are completely unaware of the hot-swap mechanism.
        return new Proxy({} as any, {
          get(_target, prop: string) {
            return (...args: any[]) => {
              const provider = aiConfigService.getProvider()
              return (provider as any)[prop](...args)
            }
          },
        })
      },
    },
  ],
  exports: [LLM_PROVIDER, AiConfigService],
})
export class AiModule {}
```

Import AiModule in AppModule.

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 9 - Update .env and .env.example

Remove CHAT_PROVIDER_BASE_URL, CHAT_PROVIDER_API_KEY, CHAT_MODEL,
EMBED_PROVIDER_BASE_URL, EMBED_PROVIDER_API_KEY, and EMBED_MODEL from
both .env and .env.example — these are now split between ai.config.json
(non-secret behaviour) and the new per-provider key vars below (secrets).

Add to .env (real values) and .env.example (placeholder values):

```dotenv
# ---- AI provider API keys ----
# One key per provider service. Which key is active is determined by
# ai.config.json (the provider field in each chat/embedding block).
# Add a key for each provider you intend to use. Unused keys are ignored.
# Changing a key requires a restart (env is read at process start).
# To switch providers with no restart, edit apps/api/ai.config.json instead.

OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk-...
TOGETHER_API_KEY=your-together-key
OPENROUTER_API_KEY=your-openrouter-key
# Ollama runs locally — no key needed. OLLAMA_API_KEY is optional and ignored.
```

In your real .env, only fill in the keys for providers you actually have
accounts with. Leave the others as placeholders — they are only read when
that provider is active in ai.config.json.

**Gate:** .env.example is clean. Old CHAT_PROVIDER_* and EMBED_PROVIDER_*
vars are removed. New per-provider key vars are present.

---

## Step 10 - Verify with a test endpoint

### apps/api/src/ai/ai.controller.ts (temporary — remove after Phase 4)

```typescript
import { Controller, Get, Inject } from '@nestjs/common'
import { LLM_PROVIDER, LLMProvider } from './llm-provider.interface'

@Controller('ai-test')
export class AiTestController {
  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LLMProvider,
  ) {}

  @Get('chat')
  async testChat() {
    return this.provider.chat([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Say hello in exactly three words.' },
    ])
  }

  @Get('embed')
  async testEmbed() {
    const vectors = await this.provider.embed(['hello world', 'test embedding'])
    return {
      count: vectors.length,
      dimensions: vectors[0].length,
      firstThreeValues: vectors[0].slice(0, 3),
    }
  }
}
```

Add AiTestController to AiModule's controllers array temporarily.

### Test sequence:

**1. With ai.config.json set to mock (the committed default):**

No restart needed — mock is already the default.

```
GET http://localhost:3010/ai-test/chat
```
Expected: { content: "This is a mock response from the AI provider." ... }

```
GET http://localhost:3010/ai-test/embed
```
Expected: { count: 2, dimensions: 1536, firstThreeValues: [0.01, 0.01, 0.01] }

**2. Edit ai.config.json to use openai — save the file, no restart:**

```json
{
  "provider": "openai",
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

Ensure OPENAI_API_KEY is set in .env, then immediately repeat both requests:

```
GET http://localhost:3010/ai-test/chat
```
Expected: a real model response to "Say hello in exactly three words."

```
GET http://localhost:3010/ai-test/embed
```
Expected: { count: 2, dimensions: 1536, firstThreeValues: [real float values] }

**Gate:**
- Mock responses correct with provider: mock
- Real responses correct with provider: openai
- Switching required only saving ai.config.json — no restart, no code change
- The hot-swap is the demo moment: show both working back to back

---

## Step 11 - Unit tests

### apps/api/src/ai/ai.spec.ts

```typescript
import { MockProvider } from './providers/mock.provider'

describe('MockProvider', () => {
  let provider: MockProvider

  beforeEach(() => {
    provider = new MockProvider()
  })

  it('chat returns content and usage', async () => {
    const result = await provider.chat([{ role: 'user', content: 'hello' }])
    expect(result.content).toBeTruthy()
    expect(result.usage?.totalTokens).toBeGreaterThan(0)
  })

  it('chatStream yields chunks and terminates with done: true', async () => {
    const chunks: { delta: string; done: boolean }[] = []
    for await (const chunk of provider.chatStream([
      { role: 'user', content: 'hello' },
    ])) {
      chunks.push(chunk)
    }
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[chunks.length - 1].done).toBe(true)
  })

  it('embed returns vectors of correct shape', async () => {
    const vectors = await provider.embed(['hello', 'world'])
    expect(vectors.length).toBe(2)
    expect(vectors[0].length).toBe(1536)
  })

  it('custom chat response is returned', async () => {
    const custom = new MockProvider({ chatResponse: 'custom response' })
    const result = await custom.chat([{ role: 'user', content: 'test' }])
    expect(result.content).toBe('custom response')
  })
})
```

```
npm run test --workspace=@kb/api
```

**Gate:** All four tests pass.

---

## Step 12 - Clean up

- Remove AiTestController from AiModule controllers array
- Delete apps/api/src/ai/ai.controller.ts
- Revert ai.config.json to the mock default (the safe committed state)
- Confirm npm run build --workspace=@kb/api passes after cleanup

---

## Phase 4 completion checklist

- [ ] openai package installed in apps/api only — not in packages/
- [ ] apps/api/ai.config.json created with mock as default, committed to git
- [ ] apps/api/ai.config.example.json created with all provider examples
- [ ] AI domain types added to packages/types
- [ ] LLMProvider interface created with chat, chatStream, and embed methods
- [ ] LLM_PROVIDER Symbol injection token defined
- [ ] OpenAICompatibleProvider implements LLMProvider — openai imported nowhere else
- [ ] Chat and embedding clients independently configurable per provider block
- [ ] MockProvider implements LLMProvider with canned responses
- [ ] AiConfigService reads ai.config.json on every call
- [ ] AiConfigService resolves API keys by provider name from .env keyMap
- [ ] AiModule uses Proxy pattern so LLM_PROVIDER token is always current
- [ ] AiModule imported in AppModule
- [ ] Old CHAT_PROVIDER_* and EMBED_PROVIDER_* vars removed from .env and .env.example
- [ ] Per-provider key vars (OPENAI_API_KEY etc.) added to .env and .env.example
- [ ] Mock provider test: both endpoints return correct canned responses
- [ ] OpenAI provider test: chat returns real response, embed returns 1536-dim vectors
- [ ] Hot-swap verified: switching ai.config.json took effect with no restart
- [ ] All four unit tests pass
- [ ] AiTestController removed, ai.config.json reverted to mock default
- [ ] npm run build passes cleanly

**Do not begin Phase 5 (RAG write path) until every box is checked.**

---

## Key design decisions (document in README later)

- **Chat Completions not Responses API:** OpenAI's Responses API is
  proprietary — only OpenAI implements it. Every alternative provider
  implements Chat Completions only. This is the only choice that satisfies
  the provider-agnostic requirement. Evaluators familiar with the new API
  will ask about this — have a clear answer ready.
- **ai.config.json for behaviour, .env for secrets:** Config file controls
  which provider and model to use (committed, hot-swappable). .env controls
  API keys (git-ignored, requires restart). Clean separation of concerns.
- **Provider name as the key resolver:** API keys are looked up by the
  provider name declared in ai.config.json via a keyMap in AiConfigService.
  No URL parsing, no hardcoded key names in config, no ambiguity. Adding a
  new provider means adding its key to .env and a case to the keyMap.
- **Proxy pattern in AiModule:** The LLM_PROVIDER token is a Proxy that
  delegates to AiConfigService.getProvider() on every method call. Consuming
  services never see AiConfigService — the hot-swap is fully encapsulated.
- **Two-layer design:** LLMProvider interface (domain types, no SDK imports)
  + OpenAICompatibleProvider adapter (SDK quarantined here only). Application
  code depends only on the interface token, never on a concrete class.
- **Independent chat and embedding providers:** Each has its own provider
  block in ai.config.json and its own key in .env. A deployment might use
  Groq for fast cheap chat and OpenAI for embeddings simultaneously.
- **Embedding sort by index:** The embeddings API does not guarantee response
  order matches input order. Sorting by index prevents a subtle bug where
  embeddings are stored against the wrong chunk.

---

## How to swap AI providers (include in README)

Edit apps/api/ai.config.json and save. No restart required.

To use OpenAI:
```json
{
  "provider": "openai",
  "chat": { "provider": "openai", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" },
  "embedding": { "provider": "openai", "baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small" }
}
```

To use Groq for chat with OpenAI for embeddings:
```json
{
  "provider": "openai",
  "chat": { "provider": "groq", "baseUrl": "https://api.groq.com/openai/v1", "model": "llama-3.1-8b-instant" },
  "embedding": { "provider": "openai", "baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small" }
}
```

To use local Ollama:
```json
{
  "provider": "openai",
  "chat": { "provider": "ollama", "baseUrl": "http://localhost:11434/v1", "model": "llama3.2" },
  "embedding": { "provider": "ollama", "baseUrl": "http://localhost:11434/v1", "model": "nomic-embed-text" }
}
```
Note: nomic-embed-text produces 768-dim vectors. Switching to Ollama for
embeddings requires a database migration. Chat provider is freely swappable.

To use the mock provider (no API key needed):
```json
{ "provider": "mock" }
```

API keys (OPENAI_API_KEY, GROQ_API_KEY etc.) are set in .env and require
a restart only when the key itself changes — not when switching providers.

---

## Explicitly out of scope for Phase 4

- Chunking or embedding documents (Phase 5)
- Retrieval or vector search (Phase 6)
- Chat endpoint or UI (Phase 7)
- Streaming to the frontend (Phase 8)
- Citations (Phase 9)

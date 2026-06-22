# Settings Page — AI Provider & Chunking Configuration

> **For Claude Code:** Work through this in order. This phase adds a
> settings page that exposes the ai.config.json controls through the UI.
> Stop at each verification gate and confirm it passes before continuing.
> Report the completion checklist at the end.

---

## Context

The settings page allows a signed-in user to switch AI providers, change
models, and adjust chunking behaviour through the UI rather than by editing
ai.config.json directly. Changes are written to ai.config.json on the server
via a new NestJS endpoint and take effect on the next request — no restart
needed.

**Architecture:**
- New NestJS SettingsModule with GET /settings and PATCH /settings endpoints
- GET reads and returns the current ai.config.json
- PATCH validates the incoming config and writes ai.config.json
- Both endpoints are auth-guarded (AuthGuard from Phase 2)
- New Next.js /settings page — Client Component (interactive form with
  provider dropdown, model inputs, chunking config)
- Provider selection auto-populates baseUrl and model defaults
- Mock provider hides model/baseUrl fields (nothing to configure)
- Save button triggers PATCH /settings and shows success/error feedback
- Settings accessible from /settings route, linked from the dashboard

**Supported providers and their defaults:**

| Provider    | baseUrl                              | Chat model default        | Embed model default            |
|-------------|--------------------------------------|---------------------------|-------------------------------|
| openai      | https://api.openai.com/v1            | gpt-4.1-mini              | text-embedding-3-small         |
| groq        | https://api.groq.com/openai/v1       | openai/gpt-oss-20b        | (uses openai for embed)        |
| together    | https://api.together.xyz/v1          | meta-llama/Llama-3.3-70B-Instruct-Turbo | (uses openai for embed) |
| ollama      | http://localhost:11434/v1            | llama3.2                  | nomic-embed-text               |
| mock        | (none)                               | (none)                    | (none)                         |

Note on Groq and Together AI: neither service offers embedding models.
When either is selected for chat, the embedding provider should remain
on OpenAI. The settings page handles this by keeping chat and embedding
provider selectors independent.

---

## Step 1 — Add settings types to packages/types

Add to packages/types/src/index.ts:

```typescript
// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

export type ProviderName = 'openai' | 'groq' | 'together' | 'ollama' | 'mock'

export interface ProviderBlock {
  provider: ProviderName
  baseUrl: string
  model: string
}

export interface AiConfigSettings {
  chat: ProviderBlock
  embedding: ProviderBlock
  chunking: {
    targetTokens: number
    overlapFraction: number
  }
}
```

**Gate:** npm run build --workspace=@kb/types succeeds.

---

## Step 2 — SettingsService

Reads and writes ai.config.json. Validates incoming config before writing.

### apps/api/src/settings/settings.service.ts

```typescript
import { Injectable, BadRequestException } from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import type { AiConfigSettings, ProviderName } from '@kb/types'

const VALID_PROVIDERS: ProviderName[] = [
  'openai', 'groq', 'together', 'ollama', 'mock',
]

// Sensible baseUrl defaults per provider — used for validation and
// auto-population in the frontend
const PROVIDER_DEFAULTS: Record<ProviderName, { baseUrl: string }> = {
  openai:   { baseUrl: 'https://api.openai.com/v1' },
  groq:     { baseUrl: 'https://api.groq.com/openai/v1' },
  together: { baseUrl: 'https://api.together.xyz/v1' },
  ollama:   { baseUrl: 'http://localhost:11434/v1' },
  mock:     { baseUrl: '' },
}

@Injectable()
export class SettingsService {
  private readonly configPath = path.resolve(process.cwd(), 'ai.config.json')

  read(): AiConfigSettings {
    const raw = fs.readFileSync(this.configPath, 'utf-8')
    const parsed = JSON.parse(raw)

    // Normalise to the full AiConfigSettings shape.
    // ai.config.json may be in mock shorthand { chat: { provider: 'mock' } }
    // so we fill defaults for any missing fields.
    return {
      chat: {
        provider: parsed.chat?.provider ?? 'mock',
        baseUrl: parsed.chat?.baseUrl ?? '',
        model: parsed.chat?.model ?? '',
      },
      embedding: {
        provider: parsed.embedding?.provider ?? 'openai',
        baseUrl: parsed.embedding?.baseUrl ?? 'https://api.openai.com/v1',
        model: parsed.embedding?.model ?? 'text-embedding-3-small',
      },
      chunking: {
        targetTokens: parsed.chunking?.targetTokens ?? 100,
        overlapFraction: parsed.chunking?.overlapFraction ?? 0.12,
      },
    }
  }

  write(settings: AiConfigSettings): void {
    this.validate(settings)

    const config = {
      _comment:
        'Provider behaviour config. Change and save — takes effect on next request, no restart needed. API keys stay in .env and require a restart when changed.',
      chat: {
        provider: settings.chat.provider,
        baseUrl: settings.chat.baseUrl,
        model: settings.chat.model,
      },
      embedding: {
        provider: settings.embedding.provider,
        baseUrl: settings.embedding.baseUrl,
        model: settings.embedding.model,
      },
      chunking: {
        targetTokens: settings.chunking.targetTokens,
        overlapFraction: settings.chunking.overlapFraction,
      },
    }

    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  private validate(settings: AiConfigSettings): void {
    if (!VALID_PROVIDERS.includes(settings.chat.provider)) {
      throw new BadRequestException(
        `Invalid chat provider: ${settings.chat.provider}`
      )
    }
    if (!VALID_PROVIDERS.includes(settings.embedding.provider)) {
      throw new BadRequestException(
        `Invalid embedding provider: ${settings.embedding.provider}`
      )
    }
    if (
      settings.chunking.targetTokens < 50 ||
      settings.chunking.targetTokens > 2000
    ) {
      throw new BadRequestException(
        'targetTokens must be between 50 and 2000'
      )
    }
    if (
      settings.chunking.overlapFraction < 0 ||
      settings.chunking.overlapFraction > 0.5
    ) {
      throw new BadRequestException(
        'overlapFraction must be between 0 and 0.5'
      )
    }
    // Mock provider: baseUrl and model are not required
    if (
      settings.chat.provider !== 'mock' &&
      (!settings.chat.baseUrl || !settings.chat.model)
    ) {
      throw new BadRequestException(
        'baseUrl and model are required for non-mock chat providers'
      )
    }
    if (
      settings.embedding.provider !== 'mock' &&
      (!settings.embedding.baseUrl || !settings.embedding.model)
    ) {
      throw new BadRequestException(
        'baseUrl and model are required for non-mock embedding providers'
      )
    }
  }
}
```

---

## Step 3 — SettingsController

### apps/api/src/settings/settings.controller.ts

```typescript
import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { SettingsService } from './settings.service'
import type { AiConfigSettings } from '@kb/types'

@Controller('settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getSettings() {
    return this.settingsService.read()
  }

  @Patch()
  updateSettings(@Body() body: AiConfigSettings) {
    this.settingsService.write(body)
    return { success: true, message: 'Settings saved. Changes take effect on the next request.' }
  }
}
```

### apps/api/src/settings/settings.module.ts

```typescript
import { Module } from '@nestjs/common'
import { SettingsController } from './settings.controller'
import { SettingsService } from './settings.service'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
```

Import SettingsModule in AppModule.

**Gate:** npm run build --workspace=@kb/api succeeds.

Verify endpoints with a REST client (valid Bearer token required):

```
GET http://localhost:3010/settings
```
Expected: current ai.config.json content as JSON with chat, embedding,
and chunking blocks.

```
PATCH http://localhost:3010/settings
Body: { "chat": { "provider": "mock", "baseUrl": "", "model": "" },
        "embedding": { "provider": "openai", "baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small" },
        "chunking": { "targetTokens": 100, "overlapFraction": 0.12 } }
```
Expected: { "success": true, "message": "..." }
Confirm ai.config.json on disk has been updated.

---

## Step 4 — Add settings API to apps/web

Add to apps/web/src/lib/api.ts:

```typescript
import type { AiConfigSettings } from '@kb/types'

export const settingsApi = {
  get: () => apiFetch<AiConfigSettings>('/settings'),

  update: (settings: AiConfigSettings) =>
    apiFetch<{ success: boolean; message: string }>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }),
}
```

---

## Step 5 — Settings page

### Route: app/(protected)/settings/page.tsx

This is a Client Component — the form is fully interactive with provider
selection driving dependent field updates.

```typescript
'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AiConfigSettings, ProviderName } from '@kb/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getToken(): Promise<string> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

// Provider metadata: defaults auto-populated when provider is selected
const PROVIDER_DEFAULTS: Record<ProviderName, {
  label: string
  baseUrl: string
  chatModel: string
  embedModel: string
  noEmbed: boolean   // true if provider doesn't support embeddings
}> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatModel: 'gpt-4.1-mini',        // gpt-4o-mini is deprecated; gpt-4.1-mini is current fast/cheap default
    embedModel: 'text-embedding-3-small',
    noEmbed: false,
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    chatModel: 'openai/gpt-oss-20b',   // llama-3.1-8b-instant deprecated June 2026
    embedModel: '',
    noEmbed: true,
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    chatModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', // stable active model on Together AI
    embedModel: '',
    noEmbed: true,
  },
  ollama: {
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    chatModel: 'llama3.2',
    embedModel: 'nomic-embed-text',
    noEmbed: false,
  },
  mock: {
    label: 'Mock (testing)',
    baseUrl: '',
    chatModel: '',
    embedModel: '',
    noEmbed: true,
  },
}

const PROVIDERS = Object.keys(PROVIDER_DEFAULTS) as ProviderName[]

export default function SettingsPage() {
  const [settings, setSettings] = useState<AiConfigSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load current settings on mount
  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/settings`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Failed to load settings')
        setSettings(await res.json())
      } catch (e: any) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // When chat provider changes, auto-populate baseUrl and model defaults
  const handleChatProviderChange = useCallback(
    (provider: ProviderName) => {
      if (!settings) return
      const defaults = PROVIDER_DEFAULTS[provider]
      setSettings({
        ...settings,
        chat: {
          provider,
          baseUrl: defaults.baseUrl,
          model: defaults.chatModel,
        },
      })
    },
    [settings],
  )

  // When embedding provider changes, auto-populate defaults
  const handleEmbedProviderChange = useCallback(
    (provider: ProviderName) => {
      if (!settings) return
      const defaults = PROVIDER_DEFAULTS[provider]
      setSettings({
        ...settings,
        embedding: {
          provider,
          baseUrl: defaults.baseUrl,
          model: defaults.embedModel,
        },
      })
    },
    [settings],
  )

  const handleSave = useCallback(async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(settings),
      })
      if (!res.ok) {
        const body = await res.json()
        throw new Error(body.message ?? 'Save failed')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }, [settings])

  if (loading) return <div>Loading settings...</div>
  if (!settings) return <div>Failed to load settings. {error}</div>

  const chatDefaults = PROVIDER_DEFAULTS[settings.chat.provider]
  const embedDefaults = PROVIDER_DEFAULTS[settings.embedding.provider]
  const isMock = settings.chat.provider === 'mock'

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Changes take effect on the next request — no restart needed.
          API keys are configured in the server environment and cannot
          be changed here.
        </p>
      </div>

      {/* Chat provider */}
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Chat Provider</h2>

        <div className="space-y-2">
          <Label>Provider</Label>
          <select
            value={settings.chat.provider}
            onChange={(e) =>
              handleChatProviderChange(e.target.value as ProviderName)
            }
            className="w-full border rounded px-3 py-2 text-sm"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_DEFAULTS[p].label}
              </option>
            ))}
          </select>
        </div>

        {!isMock && (
          <>
            <div className="space-y-2">
              <Label>Base URL</Label>
              <Input
                value={settings.chat.baseUrl}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    chat: { ...settings.chat, baseUrl: e.target.value },
                  })
                }
                placeholder={chatDefaults.baseUrl}
              />
            </div>

            <div className="space-y-2">
              <Label>Model</Label>
              <Input
                value={settings.chat.model}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    chat: { ...settings.chat, model: e.target.value },
                  })
                }
                placeholder={chatDefaults.chatModel}
              />
              <p className="text-xs text-muted-foreground">
                Enter any model name supported by the selected provider,
                e.g. gpt-4.1-mini, gpt-5.4-mini, llama-3.3-70b-versatile.
                Model names change frequently — check your provider's
                documentation for the latest available models.
              </p>
            </div>
          </>
        )}

        {isMock && (
          <p className="text-sm text-muted-foreground">
            Mock provider returns canned responses with no API calls.
            Useful for testing without consuming API credits.
          </p>
        )}
      </section>

      {/* Embedding provider */}
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Embedding Provider</h2>
        <p className="text-xs text-muted-foreground">
          Warning: changing the embedding model may require a database
          migration if the new model produces a different vector dimension
          than the current 1536. Only change this if you know what you
          are doing.
        </p>

        <div className="space-y-2">
          <Label>Provider</Label>
          <select
            value={settings.embedding.provider}
            onChange={(e) =>
              handleEmbedProviderChange(e.target.value as ProviderName)
            }
            className="w-full border rounded px-3 py-2 text-sm"
          >
            {PROVIDERS.filter(
              (p) => !PROVIDER_DEFAULTS[p].noEmbed || p === settings.embedding.provider
            ).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_DEFAULTS[p].label}
              </option>
            ))}
          </select>
          {chatDefaults.noEmbed && (
            <p className="text-xs text-amber-600">
              {PROVIDER_DEFAULTS[settings.chat.provider].label} does not
              support embeddings. Keep a separate embedding provider
              (OpenAI recommended).
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label>Base URL</Label>
          <Input
            value={settings.embedding.baseUrl}
            onChange={(e) =>
              setSettings({
                ...settings,
                embedding: {
                  ...settings.embedding,
                  baseUrl: e.target.value,
                },
              })
            }
          />
        </div>

        <div className="space-y-2">
          <Label>Model</Label>
          <Input
            value={settings.embedding.model}
            onChange={(e) =>
              setSettings({
                ...settings,
                embedding: {
                  ...settings.embedding,
                  model: e.target.value,
                },
              })
            }
            placeholder={embedDefaults.embedModel}
          />
        </div>
      </section>

      {/* Chunking config */}
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Document Chunking</h2>
        <p className="text-sm text-muted-foreground">
          Controls how documents are split before embedding. Changes
          affect newly saved or updated documents only — existing chunks
          in the database are not retroactively updated.
        </p>

        <div className="space-y-2">
          <Label>Target tokens per chunk</Label>
          <Input
            type="number"
            min={50}
            max={2000}
            value={settings.chunking.targetTokens}
            onChange={(e) =>
              setSettings({
                ...settings,
                chunking: {
                  ...settings.chunking,
                  targetTokens: parseInt(e.target.value, 10),
                },
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Smaller chunks (50–200) give more precise retrieval.
            Larger chunks (400–800) give more context per result.
            Current: {settings.chunking.targetTokens} tokens.
          </p>
        </div>
      </section>

      {/* API key notice — always shown regardless of provider */}
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-medium">API keys are configured on the server</p>
        <p className="mt-1">
          Provider API keys (e.g. OPENAI_API_KEY, GROQ_API_KEY) are set as
          environment variables on the server and cannot be changed here. If
          you switch to a provider whose key is not configured, chat and
          embedding requests will fail with an authentication error. Contact
          your server administrator to add or update API keys — a server
          restart is required after any key change.
        </p>

      </div>

      {/* Save */}
      <div className="flex items-center gap-3 pt-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
        {saved && (
          <span className="text-sm text-green-600">
            Saved. Changes take effect on the next request.
          </span>
        )}
        {error && (
          <span className="text-sm text-red-600">{error}</span>
        )}
      </div>
    </div>
  )
}
```

---

## Step 6 — Link settings from dashboard

Update the dashboard page to include a Settings link. Add alongside the
existing My Documents and Sign Out buttons:

```typescript
import Link from 'next/link'
import { Settings } from 'lucide-react'

// Add to dashboard page header:
<Link href="/settings">
  <Button variant="outline">
    <Settings className="h-4 w-4 mr-2" />
    Settings
  </Button>
</Link>
```

---

## Step 7 — Update middleware route protection

Confirm that /settings is covered by the existing middleware protected
route logic. The current middleware in apps/web/src/middleware.ts already
protects all routes that are not /login, /signup, or /, so /settings is
protected automatically. No middleware changes needed.

**Gate:**
- Visiting /settings while signed out redirects to /login
- Visiting /settings while signed in shows the settings form with current
  values loaded from ai.config.json
- Changing provider auto-populates baseUrl and model fields
- Selecting Mock hides the baseUrl and model fields
- Saving writes to ai.config.json (verify by checking the file or calling
  GET /settings again)
- Validation error (e.g. empty model for non-mock provider) shows error
  message from the API
- Groq/Together warning about no embedding support is visible when selected
  as chat provider
- Constant API key warning banner visible at the bottom of the form
- Settings link visible on dashboard

---

## Completion checklist

- [ ] AiConfigSettings, ProviderName, ProviderBlock types added to
      packages/types
- [ ] SettingsService with read() and write() implemented
- [ ] Validation rejects invalid providers and out-of-range chunking values
- [ ] SettingsController with GET /settings and PATCH /settings
- [ ] SettingsModule created and imported in AppModule
- [ ] GET /settings returns current config correctly
- [ ] PATCH /settings writes to ai.config.json and returns success
- [ ] Invalid PATCH returns 400 with descriptive message
- [ ] settingsApi added to apps/web/src/lib/api.ts
- [ ] /settings page loads current settings from API
- [ ] Provider dropdown auto-populates baseUrl and model on change
- [ ] Mock provider hides model and baseUrl fields
- [ ] Groq and Together AI show embedding warning
- [ ] Embedding dimension warning shown on embedding provider section
- [ ] targetTokens input has min/max constraints (50-2000)
- [ ] Constant API key warning banner visible on the settings page
- [ ] Save button writes settings and shows confirmation
- [ ] Error message shown on validation failure
- [ ] Settings link added to dashboard
- [ ] /settings redirects to /login when signed out
- [ ] Build passes cleanly

---

## Key design decisions (document in README later)

- **Settings as a UI over ai.config.json:** The settings page is a thin
  UI layer over the existing file-based config. No new data store is
  introduced — the same hot-swap mechanism from Phase 4 continues to work
  unchanged. The API endpoint reads and writes the same file AiConfigService
  reads on every request.
- **Server-side file write via API endpoint:** The frontend cannot touch
  the filesystem. The PATCH /settings endpoint validates and writes
  ai.config.json on the server. Validation is server-side so a malformed
  request cannot corrupt the config file.
- **Provider selection drives defaults:** Selecting a provider auto-fills
  sensible baseUrl and model defaults based on currently active models
  (gpt-4.1-mini for OpenAI, openai/gpt-oss-20b for Groq,
  meta-llama/Llama-3.3-70B-Instruct-Turbo for Together AI). The model
  field remains free-text so new model names (gpt-5.4-mini, future
  releases etc.) work without updating the UI code.
- **Embedding dimension warning:** Changing the embedding provider/model
  risks producing vectors of the wrong dimension. The warning in the UI
  flags this without blocking the change — a power user who knows what
  they're doing can still make the change.
- **Chunking change affects future documents only:** Changing targetTokens
  does not retroactively re-chunk existing documents. The UI notes this
  explicitly so the user understands they need to re-save documents to
  apply the new chunk size.
- **Auth-guarded but not role-restricted:** For a single-user knowledge
  base any authenticated user can change settings. In a multi-user
  production system this would require an admin role — noted in README
  as a known limitation.
- **API keys always server-side:** A constant warning banner makes clear
  that API keys live in the server environment and cannot be changed via
  the UI. This is architecturally correct (secrets must not pass through
  a browser-facing API) but creates friction when switching providers.
  Configuring API keys directly from the settings page is listed as future
  work — the correct implementation would encrypt keys before storage and
  write them to a secrets store rather than plain .env, which is out of
  scope for this assessment.

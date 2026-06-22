'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Loader2,
  Save,
  LayoutDashboard,
  Settings as SettingsIcon,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
} from 'lucide-react'
import type { AiConfigSettings, ProviderName } from '@kb/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getToken(): Promise<string> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

// Provider metadata: defaults auto-populated when provider is selected
const PROVIDER_DEFAULTS: Record<
  ProviderName,
  {
    label: string
    baseUrl: string
    chatModel: string
    embedModel: string
    noEmbed: boolean // true if provider doesn't support embeddings
  }
> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatModel: 'gpt-4.1-mini', // gpt-4o-mini is deprecated; gpt-4.1-mini is current fast/cheap default
    embedModel: 'text-embedding-3-small',
    noEmbed: false,
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    chatModel: 'openai/gpt-oss-20b', // llama-3.1-8b-instant deprecated June 2026
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

const selectClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm outline-none transition-colors focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20'

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
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load settings')
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
        const body = await res.json().catch(() => null)
        throw new Error(body?.message ?? 'Save failed')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [settings])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <SettingsIcon className="size-4" />
          </span>
          <h1 className="text-lg font-bold">Settings</h1>
        </div>
        <Link
          href="/dashboard"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <LayoutDashboard className="size-4" />
          <span className="hidden sm:inline">Dashboard</span>
        </Link>
      </header>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground gap-2">
          <Loader2 className="size-4 animate-spin" />
          Loading settings…
        </div>
      ) : !settings ? (
        <div className="flex-1 flex items-center justify-center text-destructive text-sm">
          Failed to load settings. {error}
        </div>
      ) : (
        <SettingsForm
          settings={settings}
          setSettings={setSettings}
          saving={saving}
          saved={saved}
          error={error}
          onSave={handleSave}
          onChatProviderChange={handleChatProviderChange}
          onEmbedProviderChange={handleEmbedProviderChange}
        />
      )}
    </div>
  )
}

function SettingsForm({
  settings,
  setSettings,
  saving,
  saved,
  error,
  onSave,
  onChatProviderChange,
  onEmbedProviderChange,
}: {
  settings: AiConfigSettings
  setSettings: (s: AiConfigSettings) => void
  saving: boolean
  saved: boolean
  error: string | null
  onSave: () => void
  onChatProviderChange: (p: ProviderName) => void
  onEmbedProviderChange: (p: ProviderName) => void
}) {
  const chatDefaults = PROVIDER_DEFAULTS[settings.chat.provider]
  const embedDefaults = PROVIDER_DEFAULTS[settings.embedding.provider]
  const isMock = settings.chat.provider === 'mock'

  return (
    <div className="flex-1 px-4 sm:px-6 py-6 sm:py-8 max-w-2xl mx-auto w-full space-y-8">
      <p className="text-sm text-muted-foreground">
        Changes take effect on the next request — no restart needed. API keys
        are configured in the server environment and cannot be changed here.
      </p>

      {/* Chat provider */}
      <section className="rounded-xl border border-border bg-card p-5 sm:p-6 space-y-4">
        <h2 className="text-lg font-semibold">Chat Provider</h2>

        <div className="space-y-2">
          <Label>Provider</Label>
          <select
            value={settings.chat.provider}
            onChange={(e) =>
              onChatProviderChange(e.target.value as ProviderName)
            }
            className={selectClass}
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
                Enter any model name supported by the selected provider, e.g.
                gpt-4.1-mini, gpt-5.4-mini, llama-3.3-70b-versatile.
              </p>
            </div>
          </>
        )}

        {isMock && (
          <p className="text-sm text-muted-foreground">
            Mock provider returns canned responses with no API calls. Useful for
            testing without consuming API credits.
          </p>
        )}
      </section>

      {/* Embedding provider */}
      <section className="rounded-xl border border-border bg-card p-5 sm:p-6 space-y-4">
        <h2 className="text-lg font-semibold">Embedding Provider</h2>
        <p className="text-xs text-muted-foreground">
          Warning: changing the embedding model may require a database migration
          if the new model produces a different vector dimension than the
          current 1536.
        </p>

        <div className="space-y-2">
          <Label>Provider</Label>
          <select
            value={settings.embedding.provider}
            onChange={(e) =>
              onEmbedProviderChange(e.target.value as ProviderName)
            }
            className={selectClass}
          >
            {PROVIDERS.filter(
              (p) =>
                !PROVIDER_DEFAULTS[p].noEmbed ||
                p === settings.embedding.provider,
            ).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_DEFAULTS[p].label}
              </option>
            ))}
          </select>
          {chatDefaults.noEmbed && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {PROVIDER_DEFAULTS[settings.chat.provider].label} does not support
              embeddings. Keep a separate embedding provider (OpenAI
              recommended).
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
      <section className="rounded-xl border border-border bg-card p-5 sm:p-6 space-y-4">
        <h2 className="text-lg font-semibold">Document Chunking</h2>
        <p className="text-sm text-muted-foreground">
          Controls how documents are split before embedding. Changes affect
          newly saved or updated documents only — existing chunks in the
          database are not retroactively updated.
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
            Smaller chunks (50–200) give more precise retrieval. Larger chunks
            (400–800) give more context per result. Current:{' '}
            {settings.chunking.targetTokens} tokens.
          </p>
        </div>
      </section>

      {/* API key notice — always shown regardless of provider */}
      <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
        <p className="flex items-center gap-2 font-medium">
          <KeyRound className="size-4 shrink-0" />
          API keys are configured on the server
        </p>
        <p className="mt-1">
          Provider API keys (e.g. OPENAI_API_KEY, GROQ_API_KEY) are set as
          environment variables on the server and cannot be changed here. If you
          switch to a provider whose key is not configured, chat and embedding
          requests will fail with an authentication error. After adding 
          or updating API keys — a server restart is required.
        </p>
      </div>

      {/* Save */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button onClick={onSave} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          {saving ? 'Saving…' : 'Save Settings'}
        </Button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-600">
            <CheckCircle2 className="size-4" />
            Saved. Changes take effect on the next request.
          </span>
        )}
        {error && (
          <span className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

# Token Usage Tracking & Dashboard View

> **For Claude Code:** Work through this in order. This phase adds token
> usage persistence across both chat and embedding operations, then surfaces
> the data as an interactive usage view on the dashboard with a period
> selector and cumulative line chart. Stop at each verification gate and
> confirm it passes before continuing. Report the completion checklist
> at the end.

---

## Context

Token usage data already flows through the system but is currently discarded:
- ChatService receives usage from LLMProvider.chat() via ChatResult.usage
  but never persists it
- RagService calls provider.embed() but the embedding token count is not
  captured at all

This phase adds a token_usage table (one row per LLM call), wires
persistence into both ChatService and RagService, and builds a dashboard
usage view with:
- A period selector: Today / This week / This month
- A cumulative line chart (Recharts) showing tokens accumulated over time
  within the selected period — chat and embedding as separate lines
- Aggregate stat cards below the chart showing totals for the period
- A per-conversation token breakdown table

**Key decisions:**
- Separate token_usage table — keeps messages table unchanged, makes
  aggregation queries simple, accommodates both call types via a type
  discriminator ('chat' | 'embedding')
- Embedding tokens tracked per document save/update
- Chat streaming: token counts are estimated from word count (exact counts
  require stream_options.include_usage — noted as future improvement)
- Embedding token counts estimated from character length (exact counts
  require changing the LLMProvider.embed() interface — noted as future
  improvement)
- Usage section on dashboard is a Client Component island — period selector
  is interactive, fetches fresh data on change without full page reload
- The rest of the dashboard remains a Server Component
- Time-series data is returned from the API keyed by period bucket:
  today → hours (0–23), week → day names, month → dates (1–31)
- Recharts LineChart renders the series with two lines: chat tokens and
  embedding tokens, both cumulative within the selected period

---

## Step 1 — Migration: token_usage table

Create a new migration file in supabase/migrations/ using the current UTC
timestamp:

```
supabase\migrations\20240103000000_token_usage_table.sql
```

```sql
-- =============================================================================
-- Migration: token_usage_table
-- Purpose: Persist token usage for every LLM call (chat and embedding).
--          One row per call. Aggregated and charted in the dashboard.
-- =============================================================================

create table public.token_usage (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,

  -- Discriminator: which kind of LLM call this row represents
  type              text not null check (type in ('chat', 'embedding')),

  -- Chat-specific fields (null for embedding rows)
  conversation_id   uuid references public.conversations(id) on delete set null,
  message_id        uuid references public.messages(id) on delete set null,
  prompt_tokens     integer,
  completion_tokens integer,

  -- Shared: total tokens for this call
  -- For chat: prompt_tokens + completion_tokens
  -- For embedding: total tokens across all texts embedded in the batch
  total_tokens      integer not null default 0,

  -- Which model was used
  model             text,

  created_at        timestamptz not null default now()
);

-- Index for per-user aggregation queries (primary access pattern)
create index token_usage_user_id_idx
  on public.token_usage using btree (user_id);

-- Index for date-range queries
create index token_usage_created_at_idx
  on public.token_usage using btree (created_at);

-- Composite index for the dashboard query: user + date range + type
create index token_usage_user_created_type_idx
  on public.token_usage using btree (user_id, created_at, type);

-- RLS
alter table public.token_usage enable row level security;

create policy "token_usage: users can select own rows"
  on public.token_usage for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "token_usage: users can insert own rows"
  on public.token_usage for insert
  to authenticated
  with check ((select auth.uid()) = user_id);
```

Push the migration:

```
npx supabase db push
```

**Gate:** Migration applies with no errors. token_usage table visible in
Supabase dashboard with correct columns and RLS enabled.

---

## Step 2 — Add usage types to packages/types

Add to packages/types/src/index.ts:

```typescript
// ---------------------------------------------------------------------------
// Token usage types
// ---------------------------------------------------------------------------

export type TokenUsagePeriod = 'today' | 'week' | 'month'
export type TokenUsageType = 'chat' | 'embedding'

export interface TokenUsageRow {
  id: string
  user_id: string
  type: TokenUsageType
  conversation_id: string | null
  message_id: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number
  model: string | null
  created_at: string
}

// One data point in the time-series chart.
// label: x-axis label (hour "14", day name "Mon", or date "15")
// chatTokens: cumulative chat tokens up to this point in the period
// embeddingTokens: cumulative embedding tokens up to this point
export interface UsageDataPoint {
  label: string
  chatTokens: number
  embeddingTokens: number
  totalTokens: number
}

export interface UsageAggregate {
  chatPromptTokens: number
  chatCompletionTokens: number
  chatTotalTokens: number
  chatCallCount: number
  embeddingTotalTokens: number
  embeddingCallCount: number
  grandTotalTokens: number
}

export interface ConversationUsage {
  conversationId: string
  conversationTitle: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  messageCount: number
}

export interface UsageSummary {
  period: TokenUsagePeriod
  periodLabel: string           // e.g. "Today", "This week", "June 2026"
  series: UsageDataPoint[]      // time-series for the line chart
  aggregate: UsageAggregate
  byConversation: ConversationUsage[]
}
```

**Gate:** npm run build --workspace=@kb/types succeeds.

---

## Step 3 — TokenUsageService

### apps/api/src/usage/token-usage.service.ts

```typescript
import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import type {
  TokenUsagePeriod,
  UsageSummary,
  UsageAggregate,
  UsageDataPoint,
  ConversationUsage,
} from '@kb/types'

@Injectable()
export class TokenUsageService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Record a chat token usage event. Fire and forget — never throws.
   */
  async recordChat(params: {
    userId: string
    conversationId: string
    messageId: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    model: string
  }): Promise<void> {
    const admin = this.supabase.getAdminClient()
    await admin.from('token_usage').insert({
      user_id: params.userId,
      type: 'chat',
      conversation_id: params.conversationId,
      message_id: params.messageId,
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      total_tokens: params.totalTokens,
      model: params.model,
    })
  }

  /**
   * Record an embedding token usage event. Fire and forget — never throws.
   */
  async recordEmbedding(params: {
    userId: string
    totalTokens: number
    model: string
  }): Promise<void> {
    const admin = this.supabase.getAdminClient()
    await admin.from('token_usage').insert({
      user_id: params.userId,
      type: 'embedding',
      conversation_id: null,
      message_id: null,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: params.totalTokens,
      model: params.model,
    })
  }

  /**
   * Fetch usage summary for a given period.
   * Returns aggregate totals, a cumulative time-series for charting,
   * and a per-conversation breakdown.
   */
  async getSummary(
    userId: string,
    period: TokenUsagePeriod,
  ): Promise<UsageSummary> {
    const admin = this.supabase.getAdminClient()
    const now = new Date()

    // Calculate period start in UTC
    const periodStart = this.getPeriodStart(now, period)
    const periodLabel = this.getPeriodLabel(now, period)

    const { data, error } = await admin
      .from('token_usage')
      .select(
        'type, conversation_id, prompt_tokens, completion_tokens, total_tokens, model, created_at'
      )
      .eq('user_id', userId)
      .gte('created_at', periodStart.toISOString())
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
    const rows = data ?? []

    // Build aggregate
    const aggregate: UsageAggregate = {
      chatPromptTokens: 0,
      chatCompletionTokens: 0,
      chatTotalTokens: 0,
      chatCallCount: 0,
      embeddingTotalTokens: 0,
      embeddingCallCount: 0,
      grandTotalTokens: 0,
    }

    const convTokenMap = new Map<
      string,
      { prompt: number; completion: number; total: number; count: number }
    >()

    for (const row of rows) {
      if (row.type === 'chat') {
        aggregate.chatPromptTokens += row.prompt_tokens ?? 0
        aggregate.chatCompletionTokens += row.completion_tokens ?? 0
        aggregate.chatTotalTokens += row.total_tokens
        aggregate.chatCallCount++
        if (row.conversation_id) {
          const existing = convTokenMap.get(row.conversation_id) ?? {
            prompt: 0, completion: 0, total: 0, count: 0,
          }
          convTokenMap.set(row.conversation_id, {
            prompt: existing.prompt + (row.prompt_tokens ?? 0),
            completion: existing.completion + (row.completion_tokens ?? 0),
            total: existing.total + row.total_tokens,
            count: existing.count + 1,
          })
        }
      } else {
        aggregate.embeddingTotalTokens += row.total_tokens
        aggregate.embeddingCallCount++
      }
    }
    aggregate.grandTotalTokens =
      aggregate.chatTotalTokens + aggregate.embeddingTotalTokens

    // Build cumulative time-series for the line chart
    const series = this.buildCumulativeSeries(rows, period, now, periodStart)

    // Fetch conversation titles
    const convIds = Array.from(convTokenMap.keys())
    let titleMap = new Map<string, string | null>()
    if (convIds.length > 0) {
      const { data: convData } = await admin
        .from('conversations')
        .select('id, title')
        .in('id', convIds)
      titleMap = new Map(
        (convData ?? []).map((c: { id: string; title: string | null }) => [
          c.id, c.title,
        ])
      )
    }

    const byConversation: ConversationUsage[] = Array.from(
      convTokenMap.entries()
    )
      .map(([convId, usage]) => ({
        conversationId: convId,
        conversationTitle: titleMap.get(convId) ?? null,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        messageCount: usage.count,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)

    return { period, periodLabel, series, aggregate, byConversation }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getPeriodStart(now: Date, period: TokenUsagePeriod): Date {
    const start = new Date(now)
    if (period === 'today') {
      start.setUTCHours(0, 0, 0, 0)
    } else if (period === 'week') {
      // Start of current week — Monday
      const day = start.getUTCDay()
      const diff = day === 0 ? -6 : 1 - day  // adjust for Sunday
      start.setUTCDate(start.getUTCDate() + diff)
      start.setUTCHours(0, 0, 0, 0)
    } else {
      // Start of current calendar month
      start.setUTCDate(1)
      start.setUTCHours(0, 0, 0, 0)
    }
    return start
  }

  private getPeriodLabel(now: Date, period: TokenUsagePeriod): string {
    if (period === 'today') return 'Today'
    if (period === 'week') return 'This week'
    return now.toLocaleString('en-GB', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    })
  }

  /**
   * Build a cumulative time-series array for the Recharts line chart.
   *
   * Each data point represents a bucket (hour for today, day for week/month)
   * and shows the cumulative tokens up to and including that bucket.
   *
   * Buckets with no activity carry forward the previous cumulative total
   * so the line chart is smooth and continuous rather than gapped.
   */
  private buildCumulativeSeries(
    rows: any[],
    period: TokenUsagePeriod,
    now: Date,
    periodStart: Date,
  ): UsageDataPoint[] {
    // Build bucket keys: hours 0-23, day names Mon-Sun, or dates 1-31
    const buckets = this.getBuckets(period, now, periodStart)

    // Accumulate raw tokens per bucket
    const chatByBucket = new Map<string, number>()
    const embedByBucket = new Map<string, number>()

    for (const row of rows) {
      const d = new Date(row.created_at)
      const key = this.getBucketKey(d, period)
      if (row.type === 'chat') {
        chatByBucket.set(key, (chatByBucket.get(key) ?? 0) + row.total_tokens)
      } else {
        embedByBucket.set(
          key, (embedByBucket.get(key) ?? 0) + row.total_tokens
        )
      }
    }

    // Build cumulative series
    let cumulativeChat = 0
    let cumulativeEmbed = 0
    return buckets.map((bucket) => {
      cumulativeChat += chatByBucket.get(bucket.key) ?? 0
      cumulativeEmbed += embedByBucket.get(bucket.key) ?? 0
      return {
        label: bucket.label,
        chatTokens: cumulativeChat,
        embeddingTokens: cumulativeEmbed,
        totalTokens: cumulativeChat + cumulativeEmbed,
      }
    })
  }

  private getBucketKey(date: Date, period: TokenUsagePeriod): string {
    if (period === 'today') return String(date.getUTCHours())
    if (period === 'week') {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      return days[date.getUTCDay()]
    }
    return String(date.getUTCDate())
  }

  private getBuckets(
    period: TokenUsagePeriod,
    now: Date,
    periodStart: Date,
  ): Array<{ key: string; label: string }> {
    if (period === 'today') {
      // Hours 0 to current hour
      const currentHour = now.getUTCHours()
      return Array.from({ length: currentHour + 1 }, (_, i) => ({
        key: String(i),
        label: `${String(i).padStart(2, '0')}:00`,
      }))
    }
    if (period === 'week') {
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      // Only include days up to today
      const current = new Date(periodStart)
      const result: Array<{ key: string; label: string }> = []
      while (current <= now) {
        const label = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][
          current.getUTCDay()
        ]
        result.push({ key: label, label })
        current.setUTCDate(current.getUTCDate() + 1)
      }
      return result
    }
    // Month: dates 1 to today's date
    const result: Array<{ key: string; label: string }> = []
    const current = new Date(periodStart)
    while (current <= now) {
      const date = current.getUTCDate()
      result.push({ key: String(date), label: String(date) })
      current.setUTCDate(date + 1)
    }
    return result
  }
}
```

### apps/api/src/usage/usage.module.ts

```typescript
import { Module } from '@nestjs/common'
import { TokenUsageService } from './token-usage.service'
import { UsageController } from './usage.controller'
import { SupabaseModule } from '../supabase/supabase.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [UsageController],
  providers: [TokenUsageService],
  exports: [TokenUsageService],
})
export class UsageModule {}
```

Import UsageModule in AppModule.

---

## Step 4 — UsageController

### apps/api/src/usage/usage.controller.ts

```typescript
import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { TokenUsageService } from './token-usage.service'
import type { TokenUsagePeriod } from '@kb/types'

@Controller('usage')
@UseGuards(AuthGuard)
export class UsageController {
  constructor(private readonly tokenUsage: TokenUsageService) {}

  @Get('summary')
  getSummary(
    @Query('period') period: string = 'month',
    @Request() req: any,
  ) {
    const validPeriods: TokenUsagePeriod[] = ['today', 'week', 'month']
    const safePeriod: TokenUsagePeriod = validPeriods.includes(
      period as TokenUsagePeriod
    )
      ? (period as TokenUsagePeriod)
      : 'month'

    return this.tokenUsage.getSummary(req.user.id, safePeriod)
  }
}
```

**Gate:** npm run build --workspace=@kb/api succeeds. GET /usage/summary
with no token returns 401; with valid token returns a UsageSummary object.

---

## Step 5 — Wire chat token persistence into ChatService

Add TokenUsageService as a constructor dependency in ChatService.
Import UsageModule in ChatModule.

### Update chat() — non-streaming path

After persistMessages() returns messageId, add:

```typescript
// Record token usage — fire and forget, never block the response
if (result.usage) {
  this.tokenUsage.recordChat({
    userId,
    conversationId: convId,
    messageId,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
    model: this.getCurrentChatModel(),
  }).catch(() => {})
}
```

### Update runStream() — streaming path

After persistMessages() returns messageId, add:

```typescript
// Estimate token usage for streaming — exact counts require
// stream_options: { include_usage: true } noted as future improvement
const estimatedTokens = Math.ceil(
  fullAnswer.split(/\s+/).filter(Boolean).length * 1.3
)
this.tokenUsage.recordChat({
  userId,
  conversationId: convId,
  messageId,
  promptTokens: 0,
  completionTokens: estimatedTokens,
  totalTokens: estimatedTokens,
  model: this.getCurrentChatModel(),
}).catch(() => {})
```

### getCurrentChatModel() helper

Add to ChatService:

```typescript
private getCurrentChatModel(): string {
  try {
    const raw = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'ai.config.json'),
      'utf-8'
    )
    return JSON.parse(raw)?.chat?.model ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 6 — Wire embedding token persistence into RagService

Update EmbeddingService to return token count alongside embeddings.

### Update EmbeddingService.embedTexts()

```typescript
export interface EmbedResult {
  embeddings: number[][]
  totalTokens: number
}

async embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], totalTokens: 0 }
  const embeddings = await this.llm.embed(texts)
  // Estimate: ~4 characters per token for English text
  // Exact counts require LLMProvider.embed() interface change — future work
  const totalTokens = Math.ceil(
    texts.reduce((sum, t) => sum + t.length, 0) / 4
  )
  return { embeddings, totalTokens }
}
```

Update all call sites in RagService to destructure
`{ embeddings, totalTokens }` from `embedTexts()`.

Add TokenUsageService as a constructor dependency in RagService.
Import UsageModule in RagModule.

After the embedding call in processDocument(), add:

```typescript
this.tokenUsage.recordEmbedding({
  userId,
  totalTokens,
  model: this.getCurrentEmbedModel(),
}).catch(() => {})
```

Add getCurrentEmbedModel() to RagService:

```typescript
private getCurrentEmbedModel(): string {
  try {
    const raw = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'ai.config.json'),
      'utf-8'
    )
    return JSON.parse(raw)?.embedding?.model ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
```

**Gate:** npm run build --workspace=@kb/api succeeds. After saving a
document, a row with type='embedding' appears in the token_usage table.

---

## Step 7 — Install Recharts in apps/web

Recharts may already be present if installed during the project setup.
Check apps/web/package.json first. If not present:

```
npm install recharts --workspace=@kb/web
```

**Gate:** npm install completes. `import { LineChart } from 'recharts'`
resolves without error in apps/web.

---

## Step 8 — Add usage API to apps/web

Add to apps/web/src/lib/api.ts:

```typescript
import type { UsageSummary, TokenUsagePeriod } from '@kb/types'

export const usageApi = {
  getSummary: (period: TokenUsagePeriod = 'month') =>
    apiFetch<UsageSummary>(`/usage/summary?period=${period}`),
}
```

---

## Step 9 — Dashboard usage Client Component

The usage section is a Client Component island — the period selector
triggers a client-side fetch so the chart and cards update without a
full page reload.

### Create apps/web/src/app/(protected)/dashboard/usage-panel.tsx

```typescript
'use client'
import { useState, useEffect } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { createClient } from '@/lib/supabase/client'
import type { UsageSummary, TokenUsagePeriod } from '@kb/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL

const PERIODS: { value: TokenUsagePeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
]

async function getToken(): Promise<string> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

export function UsagePanel() {
  const [period, setPeriod] = useState<TokenUsagePeriod>('month')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function fetchSummary() {
      setLoading(true)
      setError(null)
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/usage/summary?period=${period}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (!res.ok) throw new Error('Failed to load usage data')
        const data: UsageSummary = await res.json()
        if (!cancelled) setSummary(data)
      } catch (e: any) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchSummary()
    return () => { cancelled = true }
  }, [period])

  return (
    <section className="space-y-6">
      {/* Header + period selector */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Token Usage</h2>
          <p className="text-sm text-muted-foreground">
            {summary?.periodLabel ?? '—'}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1 rounded-md text-sm transition-colors ${
                period === p.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="h-48 flex items-center justify-center text-sm
          text-muted-foreground">
          Loading...
        </div>
      )}

      {error && (
        <div className="text-sm text-red-600">{error}</div>
      )}

      {!loading && !error && summary && (
        <>
          {/* Line chart */}
          {summary.series.length > 0 ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={summary.series}
                  margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 11 }} width={48} />
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      value.toLocaleString(),
                      name === 'chatTokens' ? 'Chat tokens' : 'Embedding tokens',
                    ]}
                  />
                  <Legend
                    formatter={(value) =>
                      value === 'chatTokens' ? 'Chat' : 'Embedding'
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="chatTokens"
                    stroke="#6366f1"
                    strokeWidth={2}
                    dot={false}
                    name="chatTokens"
                  />
                  <Line
                    type="monotone"
                    dataKey="embeddingTokens"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    name="embeddingTokens"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-56 flex items-center justify-center rounded-lg
              border border-dashed text-sm text-muted-foreground">
              No usage data for this period yet
            </div>
          )}

          {/* Aggregate stat cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border p-3 space-y-1">
              <p className="text-xs text-muted-foreground uppercase
                tracking-wide">Prompt</p>
              <p className="text-xl font-semibold tabular-nums">
                {summary.aggregate.chatPromptTokens.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border p-3 space-y-1">
              <p className="text-xs text-muted-foreground uppercase
                tracking-wide">Completion</p>
              <p className="text-xl font-semibold tabular-nums">
                {summary.aggregate.chatCompletionTokens.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border p-3 space-y-1">
              <p className="text-xs text-muted-foreground uppercase
                tracking-wide">Embedding</p>
              <p className="text-xl font-semibold tabular-nums">
                {summary.aggregate.embeddingTotalTokens.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border p-3 space-y-1 bg-muted/40">
              <p className="text-xs text-muted-foreground uppercase
                tracking-wide">Total</p>
              <p className="text-xl font-semibold tabular-nums">
                {summary.aggregate.grandTotalTokens.toLocaleString()}
              </p>
            </div>
          </div>

          {/* Per-conversation breakdown */}
          {summary.byConversation.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">By conversation</h3>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">
                        Conversation
                      </th>
                      <th className="text-right px-4 py-2 font-medium">
                        Prompt
                      </th>
                      <th className="text-right px-4 py-2 font-medium">
                        Completion
                      </th>
                      <th className="text-right px-4 py-2 font-medium">
                        Total
                      </th>
                      <th className="text-right px-4 py-2 font-medium
                        hidden sm:table-cell">
                        Messages
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {summary.byConversation.map((conv) => (
                      <tr
                        key={conv.conversationId}
                        className="hover:bg-muted/30"
                      >
                        <td className="px-4 py-2 max-w-xs truncate">
                          {conv.conversationTitle ?? 'Untitled'}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums
                          text-muted-foreground">
                          {conv.promptTokens.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums
                          text-muted-foreground">
                          {conv.completionTokens.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums
                          font-medium">
                          {conv.totalTokens.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums
                          text-muted-foreground hidden sm:table-cell">
                          {conv.messageCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
```

### Add UsagePanel to the dashboard Server Component

In app/(protected)/dashboard/page.tsx, import and render the panel below
the existing dashboard content:

```typescript
import { UsagePanel } from './usage-panel'

// Add below existing content in the return:
<UsagePanel />
```

No server-side data fetch needed for the usage section — the Client
Component handles its own fetching.

**Gate:**
- Dashboard shows the usage section with period selector buttons
- Clicking Today / This week / This month updates the chart and cards
- Line chart renders with two lines (chat in indigo, embedding in green)
- Stat cards show correct totals for the selected period
- Empty state (dashed border placeholder) shown when no data exists
- Per-conversation table appears when chat activity exists
- On mobile, the Messages column is hidden

---

## Step 10 — Integration tests

### Test 1 — Chat tokens recorded

Ask a question via the chat UI. Visit the dashboard and check:
- The chat line on the chart rises at the correct time bucket
- Prompt + completion aggregate cards show non-zero values
- The conversation appears in the breakdown table

### Test 2 — Embedding tokens recorded

Save a new document or update content. Visit the dashboard:
- The embedding line on the chart rises
- Embedding aggregate card shows non-zero value

### Test 3 — Period selector

With data from Tests 1 and 2, switch between Today / This week /
This month and confirm:
- Chart x-axis labels change (hours / day names / dates)
- Totals update correctly
- Switching back shows the same data

### Test 4 — Supabase verification

Check the token_usage table in the Supabase dashboard:
- Chat rows have prompt_tokens, completion_tokens, conversation_id,
  message_id populated
- Embedding rows have total_tokens populated, other fields null

**Gate:** All four tests pass.

---

## Completion checklist

- [ ] token_usage migration created and pushed
- [ ] token_usage table visible with RLS enabled
- [ ] TokenUsagePeriod, UsageDataPoint, UsageAggregate, ConversationUsage,
      UsageSummary types added to packages/types
- [ ] TokenUsageService with recordChat(), recordEmbedding(), getSummary()
- [ ] getSummary() returns aggregate, cumulative series, and byConversation
- [ ] UsageModule created and imported in AppModule
- [ ] UsageController GET /usage/summary accepts period query param
- [ ] Invalid period falls back to 'month'
- [ ] TokenUsageService imported into ChatModule and injected into ChatService
- [ ] chat() non-streaming records usage after each call
- [ ] runStream() records estimated usage after stream completes
- [ ] EmbeddingService.embedTexts() returns EmbedResult with totalTokens
- [ ] All call sites of embedTexts() updated to destructure EmbedResult
- [ ] RagService records embedding usage after processDocument()
- [ ] UsageModule imported into RagModule
- [ ] Recharts installed in apps/web
- [ ] usageApi added to apps/web/src/lib/api.ts
- [ ] UsagePanel Client Component created
- [ ] Period selector (Today / This week / This month) works correctly
- [ ] Line chart renders with chat and embedding lines
- [ ] Chart x-axis labels match the selected period
- [ ] Aggregate stat cards update on period change
- [ ] Per-conversation table renders and is sorted by total tokens
- [ ] Empty state shown when no data for period
- [ ] Mobile: Messages column hidden on small screens
- [ ] Build passes cleanly

---

## Key design decisions (document in README later)

- **Client Component island for usage panel:** The period selector is
  interactive — it triggers a fresh fetch on change. The rest of the
  dashboard stays a Server Component. This follows the same server shell
  + client island pattern used throughout the project.
- **Cumulative line chart:** Shows how tokens accumulate over the period
  rather than per-bucket bars. Makes total spend at any point in the
  period immediately readable, and two lines (chat vs embedding) gives
  a clear split without needing a stacked chart.
- **Separate token_usage table:** Keeps messages table focused on content.
  Aggregation queries are clean without joins. Accommodates both call
  types in one place with a type discriminator.
- **Fire and forget writes:** Token recording never throws or blocks the
  main request. A failed usage write must never break a chat response
  or document save.
- **Streaming token estimation:** Exact counts require
  stream_options: { include_usage: true } — noted as future improvement.
- **Embedding token estimation:** Character-based (÷4). Exact counts
  require LLMProvider.embed() interface change — noted as future
  improvement.
- **Calendar-aligned period boundaries:** Today = UTC midnight to now,
  week = Monday to now, month = 1st to now. Simple, unambiguous, and
  consistent regardless of timezone.

---

## Explicitly out of scope

- Cost estimation in currency (requires per-model pricing table)
- Historical period navigation (previous months/weeks)
- Exact streaming token counts via stream_options.include_usage
- Exact embedding token counts via interface change
- Usage alerts or limits

import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import type {
  TokenUsagePeriod,
  UsageSummary,
  UsageAggregate,
  UsageDataPoint,
  ConversationUsage,
} from '@kb/types'

// Shape of the columns we select from token_usage for the summary query.
interface UsageQueryRow {
  type: 'chat' | 'embedding'
  conversation_id: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number
  model: string | null
  created_at: string
}

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
        'type, conversation_id, prompt_tokens, completion_tokens, total_tokens, model, created_at',
      )
      .eq('user_id', userId)
      .gte('created_at', periodStart.toISOString())
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
    const rows = (data ?? []) as UsageQueryRow[]

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
            prompt: 0,
            completion: 0,
            total: 0,
            count: 0,
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
          c.id,
          c.title,
        ]),
      )
    }

    const byConversation: ConversationUsage[] = Array.from(
      convTokenMap.entries(),
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
      const diff = day === 0 ? -6 : 1 - day // adjust for Sunday
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
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
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
    rows: UsageQueryRow[],
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
          key,
          (embedByBucket.get(key) ?? 0) + row.total_tokens,
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
      // Only include days up to today
      const current = new Date(periodStart)
      const result: Array<{ key: string; label: string }> = []
      while (current <= now) {
        const label = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
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

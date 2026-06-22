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
  { value: 'week', label: 'Last 7 days' },
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
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!res.ok) throw new Error('Failed to load usage data')
        const data: UsageSummary = await res.json()
        if (!cancelled) setSummary(data)
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load usage data')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchSummary()
    return () => {
      cancelled = true
    }
  }, [period])

  return (
    <section className="space-y-6 rounded-xl border border-border bg-card p-5 sm:p-6">
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
        <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
          Loading...
        </div>
      )}

      {error && <div className="text-sm text-red-600">{error}</div>}

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
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 11 }} width={48} />
                  <Tooltip
                    labelFormatter={(_label, payload) =>
                      payload?.[0]?.payload?.fullLabel ?? _label
                    }
                    formatter={(value, name) => [
                      Number(value).toLocaleString(),
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
            <div className="h-56 flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              No usage data for this period yet
            </div>
          )}

          {/* Aggregate stat cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border p-3 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Prompt
              </p>
              <p className="text-xl font-semibold tabular-nums">
                {summary.aggregate.chatPromptTokens.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border p-3 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Completion
              </p>
              <p className="text-xl font-semibold tabular-nums">
                {summary.aggregate.chatCompletionTokens.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border p-3 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Embedding
              </p>
              <p className="text-xl font-semibold tabular-nums">
                {summary.aggregate.embeddingTotalTokens.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border p-3 space-y-1 bg-muted/40">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Total
              </p>
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
                      <th className="text-right px-4 py-2 font-medium hidden sm:table-cell">
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
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {conv.promptTokens.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {conv.completionTokens.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium">
                          {conv.totalTokens.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
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

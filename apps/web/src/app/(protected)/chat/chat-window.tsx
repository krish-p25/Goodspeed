'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Send, FileText, User, Bot, Quote } from 'lucide-react'
import type { ChatSseEvent, Message, DocumentSource } from '@kb/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getToken(): Promise<string> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

interface TextSegment {
  type: 'text'
  text: string
}

interface CitationSegment {
  type: 'citation'
  ids: string[]
  sentences: Array<{
    id: string
    documentTitle: string
    text: string
  }>
  markerText: string
}

type AnswerSegment = TextSegment | CitationSegment

interface ChatMessage {
  role: 'user' | 'assistant'
  segments: AnswerSegment[]
  sources?: DocumentSource[]
  noContext?: boolean
  streaming?: boolean // true while the assistant is still generating
}

/** Flatten a segments array down to its plain text (used for user messages). */
function segmentsToText(segments: AnswerSegment[]): string {
  return segments.map((s) => (s.type === 'text' ? s.text : '')).join('')
}

/**
 * Renders an assistant answer as interleaved text and citation spans.
 * Citation segments become yellow highlighted markers with a hover tooltip
 * showing the source document title and the exact cited sentence.
 */
function AnswerRenderer({ segments }: { segments: AnswerSegment[] }) {
  return (
    <span className="whitespace-pre-wrap leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <span key={i}>{seg.text}</span>
        }
        return (
          <span key={i} className="relative group inline-block align-baseline">
            <sup className="inline-flex items-center gap-0.5 rounded bg-primary/12 text-primary px-1 mx-0.5 cursor-help text-[0.65rem] font-semibold align-super leading-none ring-1 ring-primary/20 group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
              <Quote className="size-2.5" />
              cite
            </sup>
            <span className="absolute bottom-full left-0 z-10 hidden group-hover:block w-72 p-2.5 bg-popover border border-border rounded-lg shadow-lg text-sm">
              {seg.sentences.map((s) => (
                <span key={s.id} className="block mb-1 last:mb-0">
                  <span className="font-medium text-muted-foreground text-xs">
                    {s.documentTitle}
                  </span>
                  <span className="block text-foreground mt-0.5">
                    &ldquo;{s.text}&rdquo;
                  </span>
                </span>
              ))}
            </span>
          </span>
        )
      })}
    </span>
  )
}

export function ChatWindow({
  conversationId: initialConversationId,
  initialMessages,
}: {
  conversationId?: string
  initialMessages: Message[]
}) {
  const router = useRouter()
  const [conversationId, setConversationId] = useState<string | undefined>(
    initialConversationId,
  )
  const [messages, setMessages] = useState<ChatMessage[]>(
    initialMessages.map((m) => ({
      role: m.role,
      segments: [{ type: 'text', text: m.content }],
    })),
  )
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Abort any in-flight stream if the component unmounts
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || streaming) return
    const question = input.trim()
    setInput('')
    setStreaming(true)

    // Add user message + placeholder assistant message that fills as tokens arrive
    setMessages((prev) => [
      ...prev,
      { role: 'user', segments: [{ type: 'text', text: question }] },
      { role: 'assistant', segments: [], streaming: true },
    ])

    const abort = new AbortController()
    abortRef.current = abort

    const failLast = (content: string) => {
      setMessages((prev) => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last?.role === 'assistant') {
          updated[updated.length - 1] = {
            ...last,
            segments: [{ type: 'text', text: content }],
            streaming: false,
          }
        }
        return updated
      })
    }

    try {
      const token = await getToken()
      const params = new URLSearchParams({ question })
      if (conversationId) params.set('conversationId', conversationId)

      const response = await fetch(`${API_URL}/chat/stream?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: abort.signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`Stream request failed: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE events are delimited by double newline
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''

        for (const eventBlock of events) {
          const dataLine = eventBlock
            .split('\n')
            .find((line) => line.startsWith('data: '))
          if (!dataLine) continue

          let event: ChatSseEvent
          try {
            event = JSON.parse(dataLine.slice(6)) as ChatSseEvent
          } catch {
            continue
          }

          if (event.type === 'token') {
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last?.role === 'assistant') {
                const lastSeg = last.segments[last.segments.length - 1]
                if (lastSeg?.type === 'text') {
                  // Append to the existing trailing text segment
                  updated[updated.length - 1] = {
                    ...last,
                    segments: [
                      ...last.segments.slice(0, -1),
                      { type: 'text', text: lastSeg.text + event.delta },
                    ],
                  }
                } else {
                  // Start a new text segment (after a citation, or first token)
                  updated[updated.length - 1] = {
                    ...last,
                    segments: [
                      ...last.segments,
                      { type: 'text', text: event.delta },
                    ],
                  }
                }
              }
              return updated
            })
          } else if (event.type === 'citation') {
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last?.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  segments: [
                    ...last.segments,
                    {
                      type: 'citation',
                      ids: event.ids,
                      sentences: event.sentences,
                      markerText: event.markerText,
                    },
                  ],
                }
              }
              return updated
            })
          } else if (event.type === 'sources') {
            const convId = event.conversationId
            setConversationId(convId)
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last?.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  sources: event.sources,
                  streaming: false,
                  noContext: event.sources.length === 0,
                }
              }
              return updated
            })
            // Sync URL on first message of a new conversation
            if (!initialConversationId) {
              router.replace(`/chat/${convId}`)
              router.refresh()
            }
          } else if (event.type === 'error') {
            failLast('Something went wrong. Please try again.')
          }
          // done event: cleanup already handled by the sources event
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      failLast('Something went wrong. Please try again.')
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [input, streaming, conversationId, initialConversationId, router])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground py-16">
              <Bot className="size-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm">
                Ask a question about your documents to get started.
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="shrink-0 size-8 rounded-full bg-gradient-to-br from-primary to-primary/70 text-primary-foreground flex items-center justify-center shadow-sm">
                  <Bot className="size-4" />
                </div>
              )}

              <div
                className={`rounded-lg px-4 py-2.5 max-w-[80%] text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : msg.noContext
                      ? 'bg-muted/50 text-muted-foreground border border-dashed border-border'
                      : 'bg-muted text-foreground'
                }`}
              >
                <p className="whitespace-pre-wrap leading-relaxed">
                  {msg.role === 'assistant' ? (
                    <AnswerRenderer segments={msg.segments} />
                  ) : (
                    segmentsToText(msg.segments)
                  )}
                  {msg.streaming && (
                    <span className="inline-block w-1.5 h-4 ml-0.5 -mb-0.5 bg-current animate-pulse" />
                  )}
                </p>

                {msg.sources && msg.sources.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-border/60 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium opacity-70">Sources:</span>
                    {msg.sources.map((s) => (
                      <span
                        key={s.documentId}
                        className="inline-flex items-center gap-1 text-xs bg-background/60 rounded px-1.5 py-0.5"
                      >
                        <FileText className="size-3" />
                        {s.documentTitle}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {msg.role === 'user' && (
                <div className="shrink-0 size-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="size-4 text-primary" />
                </div>
              )}
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="border-t border-border bg-background px-4 sm:px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your documents…"
            disabled={streaming}
            rows={1}
            className="resize-none min-h-[44px] max-h-40"
          />
          <Button
            onClick={handleSubmit}
            disabled={streaming || !input.trim()}
            size="icon"
            className="shrink-0 size-11"
          >
            {streaming ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

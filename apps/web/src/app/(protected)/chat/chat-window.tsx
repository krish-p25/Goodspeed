'use client'
import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Send, FileText, User, Bot } from 'lucide-react'
import type { ChatResponse, Message, DocumentSource } from '@kb/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: DocumentSource[]
  noContext?: boolean
}

async function sendChat(body: {
  question: string
  conversationId?: string
}): Promise<ChatResponse> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token ?? ''
  const res = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Chat request failed')
  return res.json()
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
    initialMessages.map((m) => ({ role: m.role, content: m.content })),
  )
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function handleSubmit() {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')

    // Optimistic user message
    setMessages((prev) => [...prev, { role: 'user', content: question }])
    setLoading(true)

    try {
      const response = await sendChat({ question, conversationId })

      // First message of a new chat: capture the conversation ID and sync the URL
      if (!conversationId) {
        setConversationId(response.conversationId)
        router.replace(`/chat/${response.conversationId}`)
        // Refresh the server tree so the conversation appears in the sidebar list
        router.refresh()
      }

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: response.answer,
          sources: response.sources,
          noContext: response.noContext,
        },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Something went wrong. Please try again.' },
      ])
    } finally {
      setLoading(false)
    }
  }

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
          {messages.length === 0 && !loading && (
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
                <div className="shrink-0 size-8 rounded-full bg-muted flex items-center justify-center">
                  <Bot className="size-4 text-muted-foreground" />
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
                <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>

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

          {loading && (
            <div className="flex gap-3 justify-start">
              <div className="shrink-0 size-8 rounded-full bg-muted flex items-center justify-center">
                <Bot className="size-4 text-muted-foreground" />
              </div>
              <div className="rounded-lg px-4 py-2.5 bg-muted text-muted-foreground text-sm flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                Thinking…
              </div>
            </div>
          )}

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
            disabled={loading}
            rows={1}
            className="resize-none min-h-[44px] max-h-40"
          />
          <Button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            size="icon"
            className="shrink-0 size-11"
          >
            {loading ? (
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

# Phase 8 — SSE Streaming

> **For Claude Code:** Work through this in order. Phase 8 converts the chat
> response from a single JSON payload to a Server-Sent Events stream. The
> retrieval, prompt construction, and persistence logic from Phase 7 is
> unchanged — only the transport layer and the frontend rendering change.
> Stop at each verification gate and confirm it passes before continuing.
> Report the completion checklist at the end.

---

## Context

Phase 8 adds streaming so tokens arrive in the UI as the model generates
them rather than after the full response is complete. This is the highest-
visibility UX improvement in the assessment and the most compelling moment
in the Loom demo.

**Architecture:**
- NestJS exposes a new `POST /chat/stream` endpoint using the `@Sse()`
  decorator and RxJS `Observable`. This is NestJS's built-in SSE primitive
  — no extra libraries needed.
- The endpoint emits a sequence of typed SSE events:
  - `token` events carry individual text deltas as they arrive
  - `sources` event carries the document-level citations after the stream ends
  - `done` event signals stream completion
  - `error` event signals a failure
- The frontend `ChatWindow` Client Component opens a connection using the
  Fetch API with streaming response reading (not the browser's native
  `EventSource` — because `EventSource` does not support POST requests or
  custom headers, which are required for the Bearer token).
- Persistence happens after the stream completes: the full assembled answer
  is written to the database with the same ConversationService used in Phase 7.
- The non-streaming `POST /chat` endpoint from Phase 7 is kept intact.
  It remains useful for testing and background operations.
- ai.config.json stays on openai — do not change it.

---

## Step 1 — Add streaming types to packages/types

Add to packages/types/src/index.ts:

```typescript
// ---------------------------------------------------------------------------
// SSE streaming event types
// These are the typed events emitted by POST /chat/stream
// ---------------------------------------------------------------------------

export type SseEventType = 'token' | 'sources' | 'done' | 'error'

export interface TokenEvent {
  type: 'token'
  delta: string        // the new token text
}

export interface SourcesEvent {
  type: 'sources'
  sources: DocumentSource[]
  conversationId: string
  messageId: string
}

export interface DoneEvent {
  type: 'done'
}

export interface ErrorEvent {
  type: 'error'
  message: string
}

export type ChatSseEvent = TokenEvent | SourcesEvent | DoneEvent | ErrorEvent
```

**Gate:** npm run build --workspace=@kb/types succeeds.

---

## Step 2 — Add chatStream method to ChatService

Add a streaming variant alongside the existing chat() method. The pipeline
is identical up to the LLM call — where chat() calls llm.chat(), chatStream()
calls llm.chatStream() and yields chunks.

Add to apps/api/src/chat/chat.service.ts:

```typescript
import { Observable, Subject } from 'rxjs'
import type { ChatSseEvent } from '@kb/types'

/**
 * Streaming chat pipeline. Returns an RxJS Observable that emits typed
 * SSE events as the model generates tokens.
 *
 * Event sequence:
 *   token (×N) → sources (×1) → done (×1)
 *   or on failure: error (×1)
 *
 * Persistence (conversation + messages + message_sources) happens after
 * the stream completes, once the full answer has been assembled.
 */
chatStream(params: {
  question: string
  userId: string
  conversationId?: string
  accessToken: string
}): Observable<{ data: string }> {
  const subject = new Subject<{ data: string }>()

  // Run the async pipeline and push events to the subject.
  // Errors are caught and emitted as error events rather than thrown —
  // the Subject must always complete so the SSE connection closes cleanly.
  this.runStream(params, subject).catch((err) => {
    const event: ChatSseEvent = {
      type: 'error',
      message: err?.message ?? 'Stream failed',
    }
    subject.next({ data: JSON.stringify(event) })
    subject.complete()
  })

  return subject.asObservable()
}

private async runStream(
  params: {
    question: string
    userId: string
    conversationId?: string
    accessToken: string
  },
  subject: Subject<{ data: string }>,
): Promise<void> {
  const { question, userId, conversationId } = params

  // Step 1: Retrieve chunks
  const chunks = await this.retrieval.retrieve({ query: question, userId })

  // Step 2: No-context short-circuit
  if (chunks.length === 0) {
    const convId = await this.conversation.getOrCreate({
      conversationId,
      userId,
      title: question,
    })

    const messageId = await this.conversation.persistMessages({
      conversationId: convId,
      userId,
      question,
      answer: this.promptBuilder.noContextResponse,
      sources: [],
      retrievedChunks: [],
    })

    // Emit the full no-context answer as a single token event then finish
    const tokenEvent: ChatSseEvent = {
      type: 'token',
      delta: this.promptBuilder.noContextResponse,
    }
    subject.next({ data: JSON.stringify(tokenEvent) })

    const sourcesEvent: ChatSseEvent = {
      type: 'sources',
      sources: [],
      conversationId: convId,
      messageId,
    }
    subject.next({ data: JSON.stringify(sourcesEvent) })

    const doneEvent: ChatSseEvent = { type: 'done' }
    subject.next({ data: JSON.stringify(doneEvent) })
    subject.complete()
    return
  }

  // Step 3: Get or create conversation and fetch history
  const convId = await this.conversation.getOrCreate({
    conversationId,
    userId,
    title: question,
  })
  const history = await this.conversation.getHistory(convId, 6)

  // Step 4: Build prompt
  const messages = this.promptBuilder.buildMessages({ question, chunks, history })

  // Step 5: Stream tokens
  let fullAnswer = ''

  for await (const chunk of this.llm.chatStream(messages)) {
    if (chunk.delta) {
      fullAnswer += chunk.delta
      const tokenEvent: ChatSseEvent = { type: 'token', delta: chunk.delta }
      subject.next({ data: JSON.stringify(tokenEvent) })
    }
    if (chunk.done) break
  }

  // Step 6: Persist after stream completes
  const sources = this.promptBuilder.extractDocumentSources(chunks)
  const messageId = await this.conversation.persistMessages({
    conversationId: convId,
    userId,
    question,
    answer: fullAnswer,
    sources,
    retrievedChunks: chunks,
  })

  // Step 7: Emit sources and done
  const sourcesEvent: ChatSseEvent = {
    type: 'sources',
    sources,
    conversationId: convId,
    messageId,
  }
  subject.next({ data: JSON.stringify(sourcesEvent) })

  const doneEvent: ChatSseEvent = { type: 'done' }
  subject.next({ data: JSON.stringify(doneEvent) })
  subject.complete()
}
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 3 — Add the streaming endpoint to ChatController

NestJS SSE uses the @Sse() decorator and expects the handler to return an
Observable<MessageEvent>. The data field of each emission becomes the SSE
data payload.

Add to apps/api/src/chat/chat.controller.ts:

```typescript
import {
  Controller, Post, Get, Body, Param,
  Request, UseGuards, Sse, Query,
} from '@nestjs/common'
import { Observable } from 'rxjs'

// Add to ChatController class:

@Sse('stream')
@UseGuards(AuthGuard)
chatStream(
  @Query('question') question: string,
  @Query('conversationId') conversationId: string | undefined,
  @Request() req: any,
): Observable<{ data: string }> {
  return this.chatService.chatStream({
    question,
    userId: req.user.id,
    conversationId,
    accessToken: req.user.accessToken,
  })
}
```

> **Why query params not body for the streaming endpoint?**
> The @Sse() decorator in NestJS works with GET-style SSE connections.
> Although we open the connection with fetch (POST-like), NestJS's SSE
> decorator routes on GET. The question and conversationId are passed as
> query params. The Bearer token is still sent in the Authorization header.
> This is the standard NestJS SSE pattern.

**Gate:**
- npm run build --workspace=@kb/api succeeds
- GET http://localhost:3010/chat/stream?question=test (unauthenticated)
  returns 401

---

## Step 4 — Frontend: streaming fetch in ChatWindow

The browser's native EventSource does not support custom headers (needed
for the Bearer token) or POST requests. Use the Fetch API with a streaming
response reader instead.

Replace the send handler in the ChatWindow Client Component
(apps/web/src/chat/[conversationId]/chat-window.tsx or equivalent):

```typescript
'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import type { ChatSseEvent, DocumentSource } from '@kb/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getToken(): Promise<string> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: DocumentSource[]
  noContext?: boolean
  streaming?: boolean    // true while the assistant is still generating
}

export function ChatWindow({
  conversationId: initialConversationId,
  initialMessages,
}: {
  conversationId?: string
  initialMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
}) {
  const router = useRouter()
  const [conversationId, setConversationId] = useState(initialConversationId)
  const [messages, setMessages] = useState<ChatMessage[]>(
    (initialMessages ?? []).map((m) => ({ role: m.role, content: m.content }))
  )
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || streaming) return
    const question = input.trim()
    setInput('')
    setStreaming(true)

    // Add user message optimistically
    setMessages((prev) => [...prev, { role: 'user', content: question }])

    // Add placeholder assistant message that will be filled as tokens arrive
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: '', streaming: true },
    ])

    const abort = new AbortController()
    abortRef.current = abort

    try {
      const token = await getToken()
      const params = new URLSearchParams({ question })
      if (conversationId) params.set('conversationId', conversationId)

      const response = await fetch(
        `${API_URL}/chat/stream?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        },
      )

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
          // Each SSE event block: "data: {...}\n"
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
            // Append delta to the streaming assistant message
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last?.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  content: last.content + event.delta,
                }
              }
              return updated
            })
          } else if (event.type === 'sources') {
            // Stream complete — attach sources, clear streaming flag,
            // sync conversation ID to URL
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
            // Sync URL without full navigation (preserves scroll position)
            if (!initialConversationId) {
              router.replace(`/chat/${convId}`)
              router.refresh()
            }
          } else if (event.type === 'error') {
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last?.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  content: 'Something went wrong. Please try again.',
                  streaming: false,
                }
              }
              return updated
            })
          }
          // done event: nothing to do — sources event already handled cleanup
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      setMessages((prev) => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last?.role === 'assistant') {
          updated[updated.length - 1] = {
            ...last,
            content: 'Something went wrong. Please try again.',
            streaming: false,
          }
        }
        return updated
      })
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [input, streaming, conversationId, initialConversationId, router])

  return (
    <div>
      {/* Message list */}
      <div>
        {messages.map((msg, i) => (
          <div key={i}>
            <span>{msg.role === 'user' ? 'You' : 'Assistant'}</span>
            <p>
              {msg.content}
              {msg.streaming && <span>▊</span>}  {/* cursor indicator */}
            </p>
            {msg.sources && msg.sources.length > 0 && (
              <div>
                <span>Sources:</span>
                {msg.sources.map((s) => (
                  <span key={s.documentId}>{s.documentTitle}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder="Ask a question about your documents..."
          disabled={streaming}
        />
        <Button onClick={handleSubmit} disabled={streaming || !input.trim()}>
          {streaming ? 'Generating...' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
```

**Gate:**
- Asking a question causes tokens to appear one by one in the UI
- Source documents appear below the answer after the stream completes
- A blinking cursor is visible while streaming
- Sending a new message while streaming is disabled (button disabled)
- The URL updates to /chat/{id} on a new conversation's first message

---

## Step 5 — Integration tests

### Test 1 — Token streaming visible

Ask a question that requires a multi-sentence answer. Confirm:
- Tokens appear progressively in the UI (not all at once)
- Sources appear below the answer after completion
- The conversation is persisted (check Supabase dashboard or navigate
  away and back to confirm history loads)

### Test 2 — No-context streaming

Ask an off-topic question. Confirm:
- The no-context message streams as a single token event
- No sources shown
- Styled distinctly (muted appearance from Phase 7)

### Test 3 — Conversation continuity over stream

Start a conversation with a relevant question (streamed). Then ask a
follow-up. Confirm the follow-up answer references the prior context
and uses the same conversationId.

### Test 4 — Stream endpoint direct test

Using a REST client that supports SSE (or curl):

```
curl -N -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:3010/chat/stream?question=How+does+RAG+work"
```

Expected: sequence of SSE events in the terminal:
```
data: {"type":"token","delta":"Retrieval"}
data: {"type":"token","delta":" Augmented"}
...
data: {"type":"sources","sources":[...],"conversationId":"...","messageId":"..."}
data: {"type":"done"}
```

**Gate:** All four tests pass. Token events visible in curl output.

---

## Phase 8 completion checklist

- [ ] Streaming SSE types added to packages/types
- [ ] chatStream() method added to ChatService using RxJS Subject
- [ ] runStream() private method handles full async pipeline
- [ ] No-context path emits correct event sequence in streaming mode
- [ ] @Sse('stream') endpoint added to ChatController
- [ ] Question and conversationId passed as query params to stream endpoint
- [ ] Build passes cleanly
- [ ] Unauthenticated stream request returns 401
- [ ] ChatWindow replaced with streaming fetch reader implementation
- [ ] Tokens appear progressively in the UI
- [ ] Cursor indicator visible while streaming
- [ ] Sources appear after stream completes
- [ ] URL syncs to /chat/{id} on first message of new conversation
- [ ] Non-streaming POST /chat still works (Phase 7 endpoint untouched)
- [ ] Conversation history persisted after stream completes
- [ ] curl SSE test shows typed event sequence

**Do not begin Phase 9 (Citations) until every box is checked.**

---

## Key design decisions (document in README later)

- **RxJS Subject wrapping an async generator:** NestJS @Sse() expects an
  Observable. The async generator from LLMProvider.chatStream() is not
  directly an Observable. Wrapping in a Subject bridges the two worlds
  cleanly — the async pipeline pushes events to the Subject, which the
  Observable delivers to NestJS's SSE transport.
- **Fetch API not EventSource:** The browser's native EventSource does not
  support custom headers or POST requests. Fetch with a streaming body
  reader gives full control over headers (Bearer token) and request method
  while still consuming the SSE byte stream correctly.
- **Persistence after stream completes:** The full answer is assembled from
  token deltas during streaming and persisted in one write after the stream
  ends. This avoids partial writes and keeps the persistence logic identical
  to Phase 7.
- **Typed event protocol:** Using a discriminated union (type: 'token' |
  'sources' | 'done' | 'error') rather than raw text makes the event
  protocol explicit and type-safe on both ends. The frontend switches on
  event.type rather than fragile string parsing.
- **Non-streaming endpoint preserved:** POST /chat from Phase 7 remains
  intact. It is useful for testing, background operations, and any client
  that does not support streaming.
- **AbortController for cleanup:** The frontend holds an AbortController
  ref so the stream can be cancelled if the component unmounts or the user
  navigates away. Prevents state updates on unmounted components.

---

## Explicitly out of scope for Phase 8

- Span-level citation markers in the stream (Phase 9)
- Citation buffering / stream resolver (Phase 9)
- Token usage tracking (stretch goal — ChatResult.usage already captures it)

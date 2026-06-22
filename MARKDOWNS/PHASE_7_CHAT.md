# Phase 7 — Chat (Non-Streaming)

> **For Claude Code:** Work through this in order. Stop at each verification
> gate and confirm it passes before continuing. Get the full chat loop working
> without streaming first — Phase 8 adds streaming on top of what is built
> here. Report the completion checklist at the end.

---

## Context

Phase 7 connects all previous layers into a working chat pipeline:

1. User sends a question
2. RetrievalService embeds the question and fetches relevant chunks
3. If no chunks clear the threshold, short-circuit and return a no-context
   response without calling the LLM
4. If chunks exist, build a prompt (system message with grounding instruction
   + formatted chunks with sentence IDs + last N conversation messages)
5. Call LLMProvider.chat() and get the full response
6. Persist the conversation and both messages to the database
7. Return the response with document-level citations as a guaranteed floor

ai.config.json is already on openai from Phase 6 — do not revert it.
The conversation history window (last N messages) is read from
CONVERSATION_HISTORY_WINDOW in .env (default 6).

**Key decisions baked in:**
- Non-streaming only in this phase. Phase 8 adds SSE streaming on top.
- No-context short-circuit: if retrieve() returns [], skip the LLM call
  entirely and return a fixed message. Cheaper, faster, deterministic.
- Strict grounding: the system prompt instructs the model to answer only
  from provided context and decline if context is insufficient.
- Chunks formatted with sentence IDs in the system message for Phase 9
  citations. The format is set up correctly here so Phase 9 only needs to
  add the citation instruction and resolver.
- Conversation history: last N turns (user + assistant pairs) from the
  database are included in each prompt. Re-retrieval is fresh per question
  based on the latest user message only.
- Document-level citations (the guaranteed floor) are derived from the known
  retrieved chunks and persisted to message_sources. Sentence-level citations
  come in Phase 9 on top of this.
- Conversations are created on the first message if no conversationId is
  provided. A conversationId can be passed to continue an existing thread.

---

## Step 1 — Add conversation and message types to packages/types

Add to packages/types/src/index.ts:

```typescript
// ---------------------------------------------------------------------------
// Conversation and message types
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string
  user_id: string
  title: string | null
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  conversation_id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface MessageSource {
  id: string
  message_id: string
  chunk_id: string | null
  document_id: string | null
  sentence_text: string
  char_start: number | null
  char_end: number | null
  position: number
}

export interface ChatRequest {
  question: string
  conversationId?: string   // omit to start a new conversation
}

export interface ChatResponse {
  conversationId: string
  messageId: string         // the assistant message ID
  answer: string
  sources: DocumentSource[] // document-level citations (guaranteed floor)
  noContext: boolean        // true when retrieval returned nothing
}

export interface DocumentSource {
  documentId: string
  documentTitle: string
}
```

**Gate:** npm run build --workspace=@kb/types succeeds.

---

## Step 2 — Prompt builder service

Encapsulates all prompt construction logic. Keeping this separate from the
chat service makes the prompt template testable and easy to iterate on.

### apps/api/src/chat/prompt-builder.service.ts

```typescript
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ChatMessage, RetrievedChunk } from '@kb/types'

const NO_CONTEXT_RESPONSE =
  "I couldn't find any relevant information in your knowledge base to answer that question. " +
  'Try asking something related to the documents you have saved.'

@Injectable()
export class PromptBuilderService {
  private readonly historyWindow: number

  constructor(private readonly config: ConfigService) {
    this.historyWindow = parseInt(
      this.config.get<string>('CONVERSATION_HISTORY_WINDOW', '6'),
      10,
    )
  }

  get noContextResponse(): string {
    return NO_CONTEXT_RESPONSE
  }

  /**
   * Build the full messages array to send to the LLM.
   *
   * Structure:
   *   [system: grounding instruction + formatted chunks]
   *   [...last N conversation history messages]
   *   [user: current question]
   *
   * Chunks are placed in the system message (not the user turn) to keep
   * grounding rules and grounding data together and the user turn clean.
   */
  buildMessages(params: {
    question: string
    chunks: RetrievedChunk[]
    history: Array<{ role: 'user' | 'assistant'; content: string }>
  }): ChatMessage[] {
    const { question, chunks, history } = params

    const systemContent = [
      this.buildGroundingInstruction(),
      '',
      'Context:',
      this.formatChunks(chunks),
    ].join('\n')

    const historyMessages: ChatMessage[] = history
      .slice(-this.historyWindow)
      .map((m) => ({ role: m.role, content: m.content }))

    return [
      { role: 'system', content: systemContent },
      ...historyMessages,
      { role: 'user', content: question },
    ]
  }

  /**
   * Format retrieved chunks for the system message.
   * Each chunk is labelled with a source header and sentence IDs.
   * Sentence IDs are included so the model can cite specific sentences
   * in Phase 9 — the format is set up here so no changes are needed later.
   *
   * Format:
   *   [Source 1 | "Document Title"]
   *   (c0_s0) First sentence of the chunk.
   *   (c0_s1) Second sentence of the chunk.
   */
  formatChunks(chunks: RetrievedChunk[]): string {
    if (chunks.length === 0) return ''

    return chunks
      .map((chunk, i) => {
        const header = `[Source ${i + 1} | "${chunk.documentTitle}"]`
        const sentences = Array.from(chunk.sentences.values())
        const body =
          sentences.length > 0
            ? sentences.map((s) => `(${s.id}) ${s.text}`).join('\n')
            : chunk.content
        return `${header}\n${body}`
      })
      .join('\n\n')
  }

  /**
   * The grounding instruction is the core of the system prompt.
   * Strict grounding: the model must answer only from the provided context
   * and decline gracefully when context is insufficient.
   *
   * Note on the citation instruction: Phase 9 appends citation guidance
   * to this instruction. The base instruction here does not include it
   * so Phase 7 works cleanly without citation logic.
   */
  private buildGroundingInstruction(): string {
    return [
      'You are a knowledge base assistant. Answer the user\'s question using only the context provided below, which has been retrieved from the user\'s own documents.',
      '',
      '- Base your answer solely on the provided context.',
      '- If the context does not contain enough information to answer, say so plainly rather than guessing or drawing on outside knowledge.',
      '- Be concise and direct.',
      '- When you use information from the context, you may reference the source document by name.',
    ].join('\n')
  }

  /**
   * Extract unique document-level sources from retrieved chunks.
   * This is the guaranteed citation floor — always accurate because it
   * comes from the known retrieved chunks, not parsed from model output.
   */
  extractDocumentSources(
    chunks: RetrievedChunk[],
  ): Array<{ documentId: string; documentTitle: string }> {
    const seen = new Set<string>()
    return chunks
      .filter((c) => {
        if (seen.has(c.documentId)) return false
        seen.add(c.documentId)
        return true
      })
      .map((c) => ({ documentId: c.documentId, documentTitle: c.documentTitle }))
  }
}
```

---

## Step 3 — Conversation persistence service

Handles all database reads and writes for conversations and messages.

### apps/api/src/chat/conversation.service.ts

```typescript
import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import type { RetrievedChunk } from '@kb/types'

@Injectable()
export class ConversationService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Get or create a conversation.
   * If conversationId is provided, verify it belongs to the user and return it.
   * If not provided, create a new conversation with the question as the title.
   */
  async getOrCreate(params: {
    conversationId?: string
    userId: string
    title: string
  }): Promise<string> {
    const admin = this.supabase.getAdminClient()

    if (params.conversationId) {
      const { data } = await admin
        .from('conversations')
        .select('id')
        .eq('id', params.conversationId)
        .eq('user_id', params.userId)
        .single()

      if (!data) throw new Error('Conversation not found')
      return data.id
    }

    const { data, error } = await admin
      .from('conversations')
      .insert({
        user_id: params.userId,
        title: params.title.slice(0, 100), // truncate long questions
      })
      .select('id')
      .single()

    if (error || !data) throw new Error('Failed to create conversation')
    return data.id
  }

  /**
   * Fetch the last N messages for conversation history.
   * Returns in chronological order (oldest first) for correct prompt assembly.
   */
  async getHistory(
    conversationId: string,
    limit: number,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const admin = this.supabase.getAdminClient()
    const { data } = await admin
      .from('messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit)

    // Reverse to get chronological order for prompt assembly
    return ((data ?? []) as Array<{ role: 'user' | 'assistant'; content: string }>)
      .reverse()
  }

  /**
   * Persist user message, assistant message, and document-level citations.
   * Returns the assistant message ID for use in the chat response.
   */
  async persistMessages(params: {
    conversationId: string
    userId: string
    question: string
    answer: string
    sources: Array<{ documentId: string; documentTitle: string }>
    retrievedChunks: RetrievedChunk[]
  }): Promise<string> {
    const admin = this.supabase.getAdminClient()

    // Insert user message
    await admin.from('messages').insert({
      conversation_id: params.conversationId,
      user_id: params.userId,
      role: 'user',
      content: params.question,
    })

    // Insert assistant message
    const { data: assistantMsg, error } = await admin
      .from('messages')
      .insert({
        conversation_id: params.conversationId,
        user_id: params.userId,
        role: 'assistant',
        content: params.answer,
      })
      .select('id')
      .single()

    if (error || !assistantMsg) throw new Error('Failed to persist assistant message')

    // Persist document-level citations as message_sources
    // These are the guaranteed citation floor — accurate because they come
    // from the known retrieved chunks, not parsed from model output.
    // position tracks citation order within the message for stable footnote
    // numbering in the UI.
    if (params.sources.length > 0) {
      const sourceRows = params.sources.map((source, position) => {
        // Find the first chunk for this document to get its ID
        const chunk = params.retrievedChunks.find(
          (c) => c.documentId === source.documentId,
        )
        return {
          message_id: assistantMsg.id,
          chunk_id: chunk?.id ?? null,
          document_id: source.documentId,
          sentence_text: '',     // empty for document-level citations
          char_start: null,
          char_end: null,
          position,
        }
      })

      await admin.from('message_sources').insert(sourceRows)
    }

    // Update conversation updated_at so list ordering stays correct
    await admin
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', params.conversationId)

    return assistantMsg.id
  }
}
```

---

## Step 4 — Chat service

Orchestrates the full chat pipeline.

### apps/api/src/chat/chat.service.ts

```typescript
import { Injectable, Inject } from '@nestjs/common'
import { LLM_PROVIDER, LLMProvider } from '../ai/llm-provider.interface'
import { RetrievalService } from '../rag/retrieval.service'
import { PromptBuilderService } from './prompt-builder.service'
import { ConversationService } from './conversation.service'
import type { ChatResponse } from '@kb/types'

@Injectable()
export class ChatService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    private readonly retrieval: RetrievalService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly conversation: ConversationService,
  ) {}

  async chat(params: {
    question: string
    userId: string
    conversationId?: string
    accessToken: string
  }): Promise<ChatResponse> {
    const { question, userId, conversationId } = params

    // Step 1: Retrieve relevant chunks
    const chunks = await this.retrieval.retrieve({ query: question, userId })

    // Step 2: No-context short-circuit
    // If nothing clears the threshold, skip the LLM call entirely.
    // Still persist the conversation and messages so history is maintained.
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

      return {
        conversationId: convId,
        messageId,
        answer: this.promptBuilder.noContextResponse,
        sources: [],
        noContext: true,
      }
    }

    // Step 3: Get or create conversation and fetch history
    const convId = await this.conversation.getOrCreate({
      conversationId,
      userId,
      title: question,
    })

    const history = await this.conversation.getHistory(convId, 6)

    // Step 4: Build prompt and call LLM
    const messages = this.promptBuilder.buildMessages({
      question,
      chunks,
      history,
    })

    const result = await this.llm.chat(messages)

    // Step 5: Extract document-level sources (guaranteed citation floor)
    const sources = this.promptBuilder.extractDocumentSources(chunks)

    // Step 6: Persist messages and citations
    const messageId = await this.conversation.persistMessages({
      conversationId: convId,
      userId,
      question,
      answer: result.content,
      sources,
      retrievedChunks: chunks,
    })

    return {
      conversationId: convId,
      messageId,
      answer: result.content,
      sources,
      noContext: false,
    }
  }
}
```

---

## Step 5 — Chat module

### apps/api/src/chat/chat.module.ts

```typescript
import { Module } from '@nestjs/common'
import { ChatService } from './chat.service'
import { ChatController } from './chat.controller'
import { PromptBuilderService } from './prompt-builder.service'
import { ConversationService } from './conversation.service'
import { RagModule } from '../rag/rag.module'
import { AiModule } from '../ai/ai.module'
import { SupabaseModule } from '../supabase/supabase.module'

@Module({
  imports: [RagModule, AiModule, SupabaseModule],
  controllers: [ChatController],
  providers: [ChatService, PromptBuilderService, ConversationService],
  exports: [ChatService, PromptBuilderService],
})
export class ChatModule {}
```

---

## Step 6 — Chat controller

### apps/api/src/chat/chat.controller.ts

```typescript
import { Controller, Post, Body, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { ChatService } from './chat.service'

class ChatRequestDto {
  question: string
  conversationId?: string
}

@Controller('chat')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async chat(@Body() dto: ChatRequestDto, @Request() req: any) {
    return this.chatService.chat({
      question: dto.question,
      userId: req.user.id,
      conversationId: dto.conversationId,
      accessToken: req.user.accessToken,
    })
  }
}
```

Import ChatModule in AppModule.

**Gate:** npm run build --workspace=@kb/api succeeds with no TypeScript errors.

---

## Step 7 — Conversations list endpoint

Add a GET endpoint so the frontend can list a user's conversations. Add
this to ChatController:

```typescript
import { Controller, Post, Get, Body, Request, UseGuards } from '@nestjs/common'
import { ConversationService } from './conversation.service'

// Add to constructor:
constructor(
  private readonly chatService: ChatService,
  private readonly conversationService: ConversationService,
) {}

// Add endpoint:
@Get('conversations')
async listConversations(@Request() req: any) {
  const admin = // inject SupabaseService and use getAdminClient()
  // Simpler: add a listConversations method to ConversationService
}
```

Add to ConversationService:

```typescript
async listConversations(userId: string) {
  const admin = this.supabase.getAdminClient()
  const { data, error } = await admin
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
}
```

Add to ChatController:

```typescript
@Get('conversations')
listConversations(@Request() req: any) {
  return this.conversationService.listConversations(req.user.id)
}
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 8 — Frontend chat UI

### Route structure to add:

```
app/
  (protected)/
    chat/
      page.tsx            conversation list + new chat button
      [conversationId]/
        page.tsx          Server Component shell
        chat-window.tsx   Client Component — the interactive chat UI
```

### Chat window Client Component pattern

The chat window is a Client Component because it manages interactive state
(message input, optimistic message rendering, loading states).

Key behaviours:
- On mount, load existing messages for the conversation from the API
- User types a question and submits
- Show the user message immediately (optimistic)
- Show a loading indicator while waiting for the API response
- On response, show the assistant answer and source documents
- noContext: true responses should be visually distinct (e.g. muted styling)
- Sources rendered as a list of document names below the answer

### API utility additions (apps/web/src/lib/api.ts)

Add chat API methods:

```typescript
import type {
  ChatResponse,
  Conversation,
  Message,
} from '@kb/types'

export const chatApi = {
  send: (body: { question: string; conversationId?: string }) =>
    apiFetch<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listConversations: () =>
    apiFetch<Conversation[]>('/chat/conversations'),

  getMessages: (conversationId: string) =>
    apiFetch<Message[]>(`/chat/conversations/${conversationId}/messages`),
}
```

Add getMessages endpoint to ConversationService and ChatController:

```typescript
// ConversationService
async getMessages(conversationId: string, userId: string) {
  const admin = this.supabase.getAdminClient()
  const { data, error } = await admin
    .from('messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return data ?? []
}

// ChatController
@Get('conversations/:id/messages')
getMessages(@Param('id') id: string, @Request() req: any) {
  return this.conversationService.getMessages(id, req.user.id)
}
```

### Minimal chat window implementation

```typescript
'use client'
import { useState, useRef, useEffect } from 'react'
import { chatApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ChatResponse, Message } from '@kb/types'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: Array<{ documentId: string; documentTitle: string }>
  noContext?: boolean
}

export function ChatWindow({
  conversationId,
  initialMessages,
}: {
  conversationId: string
  initialMessages: Message[]
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(
    initialMessages.map((m) => ({ role: m.role, content: m.content }))
  )
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSubmit() {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')

    // Optimistic user message
    setMessages((prev) => [...prev, { role: 'user', content: question }])
    setLoading(true)

    try {
      const response = await chatApi.send({ question, conversationId })
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

  return (
    <div>
      <div>
        {messages.map((msg, i) => (
          <div key={i}>
            <span>{msg.role === 'user' ? 'You' : 'Assistant'}</span>
            <p>{msg.content}</p>
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
        {loading && <div>Thinking...</div>}
        <div ref={bottomRef} />
      </div>

      <div>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Ask a question about your documents..."
          disabled={loading}
        />
        <Button onClick={handleSubmit} disabled={loading || !input.trim()}>
          Send
        </Button>
      </div>
    </div>
  )
}
```

The page structure (chat/page.tsx and chat/[conversationId]/page.tsx) should
follow the same Server Component shell + Client Component island pattern used
in Phase 3 for the document editor.

**Gate:**
- Visiting /chat shows a list of conversations (empty on first visit) and
  a New Chat button
- Clicking New Chat creates a new conversation and navigates to it
- Asking a relevant question returns a grounded answer with source documents
  shown below
- Asking an off-topic question returns the no-context message
- Starting a second message in the same conversation includes history context
- Conversations persist across page refreshes

---

## Step 9 — Integration tests

With both apps running and ai.config.json on openai:

### Test 1 — Relevant question

```
POST http://localhost:3010/chat
Body: { "question": "How does RAG work?" }
```

Expected: answer grounded in document content, sources array contains the
relevant document title, noContext: false.

### Test 2 — No-context question

```
POST http://localhost:3010/chat
Body: { "question": "What is the capital of France?" }
```

Expected: noContext: true, answer is the fixed no-context message, sources: [].

### Test 3 — Conversation continuity

Send a follow-up in the same conversation:

```
POST http://localhost:3010/chat
Body: {
  "question": "Can you summarise that more briefly?",
  "conversationId": "<id from Test 1>"
}
```

Expected: response references the previous answer context, same
conversationId returned.

### Test 4 — Persistence

Check the Supabase dashboard:
- conversations table: one row per conversation created
- messages table: user and assistant messages for each turn
- message_sources table: rows for each assistant message that had sources

**Gate:** All four tests pass. Messages and sources visible in the dashboard.

---

## Phase 7 completion checklist

- [ ] Conversation, Message, MessageSource, ChatRequest, ChatResponse,
      DocumentSource types added to packages/types
- [ ] PromptBuilderService created with buildMessages, formatChunks,
      extractDocumentSources, noContextResponse
- [ ] ConversationService created with getOrCreate, getHistory,
      persistMessages, listConversations, getMessages
- [ ] ChatService created — full pipeline with no-context short-circuit
- [ ] ChatModule created and imported in AppModule
- [ ] ChatController with POST /chat, GET /chat/conversations,
      GET /chat/conversations/:id/messages
- [ ] chatApi utility added to apps/web/src/lib/api.ts
- [ ] /chat page shows conversation list and New Chat button
- [ ] /chat/[conversationId] loads and renders chat window
- [ ] Relevant question returns grounded answer with source documents
- [ ] Off-topic question returns no-context message (noContext: true)
- [ ] Conversation history included in follow-up prompts
- [ ] Conversations, messages, and message_sources persisted to DB
- [ ] Build passes cleanly

**Do not begin Phase 8 (Streaming) until every box is checked.**

---

## Key design decisions (document in README later)

- **Non-streaming first:** Get the full loop correct before adding streaming
  complexity. Phase 8 converts the LLM call to streaming and adds SSE
  transport — the rest of the pipeline (retrieval, prompt, persistence) is
  unchanged.
- **No-context short-circuit in code:** When retrieve() returns [], the LLM
  is never called. The fixed response is instant, costs nothing, and is
  deterministic — never a hallucinated answer to an off-topic question.
- **Strict grounding system prompt:** The model is instructed to answer only
  from provided context and decline otherwise. This is the correct behaviour
  for a knowledge base product where users trust answers came from their own
  documents.
- **Conversation history capped at N messages:** Last N turns (default 6)
  included in every prompt. Prevents context window overflow on long
  conversations. A known limitation: follow-up questions like "tell me more
  about that" are re-retrieved fresh based on the bare question, which may
  retrieve poorly. Query rewriting (condensing history + question into a
  standalone query before embedding) is the production fix — noted as future
  work.
- **Document-level citations as guaranteed floor:** Sources are derived from
  the known retrieved chunks before the LLM is called. Always accurate.
  Phase 9 adds sentence-level citations on top — when those work they are
  more specific; when they fail (model emits wrong IDs) the document-level
  floor is always shown.
- **Sentence IDs in chunks now, citation instruction in Phase 9:** The chunk
  formatting already includes (c0_s0) sentence ID labels. Phase 9 adds the
  citation instruction to the system prompt and the stream resolver to
  process markers. No changes to prompt formatting needed in Phase 9.

---

## Explicitly out of scope for Phase 7

- SSE streaming (Phase 8)
- Span-level citation resolution (Phase 9)
- Query rewriting for follow-up questions (future work — note in README)
- Per-document scoped chat (the retrieve() call accepts documentId but the
  UI does not expose it yet — future work)
- Token usage tracking (the ChatResult.usage field exists — a usage view
  is listed as a stretch goal)

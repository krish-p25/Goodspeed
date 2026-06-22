import { Injectable, Inject, Logger } from '@nestjs/common'
import { Observable, Subject } from 'rxjs'
import { LLM_PROVIDER } from '../ai/llm-provider.interface'
import type { LLMProvider } from '../ai/llm-provider.interface'
import { RetrievalService } from '../rag/retrieval.service'
import { PromptBuilderService } from './prompt-builder.service'
import { ConversationService } from './conversation.service'
import { CitationStreamResolver } from './citation-resolver'
import { TokenUsageService } from '../usage/token-usage.service'
import * as fs from 'fs'
import * as path from 'path'
import type { ChatResponse, ChatSseEvent, CitationStreamEvent } from '@kb/types'

// How many prior messages to load for history-aware retrieval and prompting.
const HISTORY_WINDOW = 6

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name)

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    private readonly retrieval: RetrievalService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly conversation: ConversationService,
    private readonly tokenUsage: TokenUsageService,
  ) {}

  async chat(params: {
    question: string
    userId: string
    conversationId?: string
    accessToken: string
  }): Promise<ChatResponse> {
    const { question, userId, conversationId } = params

    // Step 1: Resolve the conversation and load history BEFORE retrieval so a
    // fragmentary follow-up can be condensed into a standalone search query.
    const convId = await this.conversation.getOrCreate({
      conversationId,
      userId,
      title: question,
    })
    const history = await this.conversation.getHistory(convId, HISTORY_WINDOW)

    // Step 2: Condense the question against history, then retrieve.
    const searchQuery = await this.buildSearchQuery(question, history)
    const chunks = await this.retrieval.retrieve({ query: searchQuery, userId })

    // Step 3: No-context short-circuit
    // If nothing clears the threshold, skip the LLM call entirely.
    // Still persist the messages so history is maintained.
    if (chunks.length === 0) {
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

    // Record token usage — fire and forget, never block the response
    if (result.usage) {
      this.tokenUsage
        .recordChat({
          userId,
          conversationId: convId,
          messageId,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          model: this.getCurrentChatModel(),
        })
        .catch(() => {})
    }

    return {
      conversationId: convId,
      messageId,
      answer: result.content,
      sources,
      noContext: false,
    }
  }

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

    // Step 1: Resolve the conversation and load history BEFORE retrieval so a
    // fragmentary follow-up can be condensed into a standalone search query.
    const convId = await this.conversation.getOrCreate({
      conversationId,
      userId,
      title: question,
    })
    const history = await this.conversation.getHistory(convId, HISTORY_WINDOW)

    // Step 2: Condense the question against history, then retrieve.
    const searchQuery = await this.buildSearchQuery(question, history)
    const chunks = await this.retrieval.retrieve({ query: searchQuery, userId })

    // Step 3: No-context short-circuit
    if (chunks.length === 0) {
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

    // Step 4: Build prompt
    const messages = this.promptBuilder.buildMessages({ question, chunks, history })

    // Step 5: Stream tokens with citation resolution
    let fullAnswer = ''
    const resolver = new CitationStreamResolver(
      // Merge all sentence maps from retrieved chunks into one flat map
      new Map(chunks.flatMap((c) => Array.from(c.sentences.entries()))),
    )
    const resolvedCitations: CitationStreamEvent[] = []

    // Emit a resolved StreamSegment as a token or citation SSE event,
    // accumulating answer text and collecting citations for persistence.
    const emitSegment = (segment: {
      type: 'text' | 'citation'
      text?: string
      citation?: {
        ids: string[]
        sentences: Array<{
          id: string
          documentTitle: string
          text: string
          charStart: number
          charEnd: number
        }>
        markerText: string
      }
    }) => {
      if (segment.type === 'text' && segment.text) {
        fullAnswer += segment.text
        const tokenEvent: ChatSseEvent = { type: 'token', delta: segment.text }
        subject.next({ data: JSON.stringify(tokenEvent) })
      } else if (segment.type === 'citation' && segment.citation) {
        const { ids, sentences, markerText } = segment.citation
        // Retain the marker in the persisted answer so the citation's inline
        // position survives a reload. The live UI renders a badge from the
        // citation event; the stored markerText is only re-parsed on reload.
        fullAnswer += markerText
        const citationEvent: CitationStreamEvent = {
          type: 'citation',
          ids,
          sentences: sentences.map((s) => ({
            id: s.id,
            documentTitle: s.documentTitle,
            text: s.text,
            charStart: s.charStart,
            charEnd: s.charEnd,
          })),
          markerText,
        }
        subject.next({ data: JSON.stringify(citationEvent) })
        resolvedCitations.push(citationEvent)
      }
    }

    for await (const chunk of this.llm.chatStream(messages)) {
      if (chunk.delta) {
        for (const segment of resolver.process(chunk.delta)) {
          emitSegment(segment)
        }
      }
      if (chunk.done) break
    }

    // Flush remaining buffer after stream ends
    for (const segment of resolver.flush()) {
      emitSegment(segment)
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
      resolvedCitations:
        resolvedCitations.length > 0 ? resolvedCitations : undefined,
    })

    // Estimate token usage for streaming — exact counts require
    // stream_options: { include_usage: true } noted as future improvement
    const estimatedTokens = Math.ceil(
      fullAnswer.split(/\s+/).filter(Boolean).length * 1.3,
    )
    this.tokenUsage
      .recordChat({
        userId,
        conversationId: convId,
        messageId,
        promptTokens: 0,
        completionTokens: estimatedTokens,
        totalTokens: estimatedTokens,
        model: this.getCurrentChatModel(),
      })
      .catch(() => {})

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

  /**
   * Produce the query string used for retrieval.
   *
   * For the first turn of a conversation (no history) the raw question is
   * already standalone, so it is used as-is and no extra LLM call is made.
   * For follow-ups, the question is condensed against recent history so that
   * fragmentary references ("how long does step 2 take") resolve to the
   * document the user is actually discussing.
   *
   * Condensing is best-effort: any failure or empty result falls back to the
   * raw question so retrieval never breaks because of the rewrite step.
   */
  private async buildSearchQuery(
    question: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    if (history.length === 0) return question

    try {
      const messages = this.promptBuilder.buildCondenseMessages({
        question,
        history,
      })
      // Call the LLM exactly like the answer-generation path does — with no
      // options. Passing temperature/max_tokens here previously broke condensing
      // on reasoning models (the tiny token budget was spent on reasoning and
      // returned empty content, or the params were rejected outright), which
      // silently fell back to the raw fragment and made follow-ups fail.
      const result = await this.llm.chat(messages)
      const condensed = this.cleanCondensed(result.content)
      if (condensed.length === 0) {
        this.logger.warn(
          `Condense returned empty content for "${question}"; using raw question for retrieval.`,
        )
        return question
      }
      return condensed
    } catch (err) {
      // Never let the rewrite step take down the chat request.
      this.logger.warn(
        `Condense step failed for "${question}": ${
          err instanceof Error ? err.message : String(err)
        }. Using raw question for retrieval.`,
      )
      return question
    }
  }

  /**
   * Normalise the model's condensed query: take the first non-empty line and
   * strip a single pair of wrapping quotes. The condense prompt asks for the
   * bare query, but without a pinned temperature the model may occasionally add
   * surrounding quotes or a trailing line — this keeps retrieval clean.
   */
  private cleanCondensed(raw: string): string {
    const firstLine =
      raw
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? ''
    return firstLine.replace(/^["']|["']$/g, '').trim()
  }

  /**
   * Read the currently-configured chat model from ai.config.json so the
   * recorded usage row reflects the model actually used. Falls back to
   * 'unknown' if the file is missing or unreadable.
   */
  private getCurrentChatModel(): string {
    try {
      const raw = fs.readFileSync(
        path.resolve(process.cwd(), 'ai.config.json'),
        'utf-8',
      )
      return JSON.parse(raw)?.chat?.model ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

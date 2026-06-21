import { Injectable, Inject } from '@nestjs/common'
import { Observable, Subject } from 'rxjs'
import { LLM_PROVIDER } from '../ai/llm-provider.interface'
import type { LLMProvider } from '../ai/llm-provider.interface'
import { RetrievalService } from '../rag/retrieval.service'
import { PromptBuilderService } from './prompt-builder.service'
import { ConversationService } from './conversation.service'
import { CitationStreamResolver } from './citation-resolver'
import type { ChatResponse, ChatSseEvent, CitationStreamEvent } from '@kb/types'

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
}

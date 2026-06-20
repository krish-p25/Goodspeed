import { Injectable, Inject } from '@nestjs/common'
import { LLM_PROVIDER } from '../ai/llm-provider.interface'
import type { LLMProvider } from '../ai/llm-provider.interface'
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

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
   * Build the messages used to condense a follow-up question into a
   * standalone search query.
   *
   * Retrieval embeds a single query string, so a fragmentary follow-up like
   * "how long does step 2 take" carries none of the context needed to match
   * the right document and retrieves nothing. This rewrite folds the relevant
   * conversation history back into the question so the embedding lands on the
   * document the user is actually talking about.
   *
   * The model is instructed to return ONLY the rewritten query (no preamble),
   * and to pass already-standalone questions through unchanged.
   */
  buildCondenseMessages(params: {
    question: string
    history: Array<{ role: 'user' | 'assistant'; content: string }>
  }): ChatMessage[] {
    const { question, history } = params

    const system = [
      'You rewrite a user\'s latest message into a single standalone search query for a document retrieval system.',
      '',
      '- Use the conversation history only to resolve references (pronouns, "it", "that recipe", "step 2", etc.) into explicit terms.',
      '- Preserve the original intent and keywords; do not answer the question or add information that is not implied by the conversation.',
      '- If the latest message is already self-contained, return it unchanged.',
      '- Output ONLY the rewritten query as plain text, with no quotes, labels, or explanation.',
    ].join('\n')

    const transcript = history
      .slice(-this.historyWindow)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n')

    const user = [
      'Conversation history:',
      transcript,
      '',
      `Latest message: ${question}`,
      '',
      'Standalone search query:',
    ].join('\n')

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
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
      "You are a knowledge base assistant. Answer the user's question using only the context provided below, which has been retrieved from the user's own documents.",
      '',
      '- Base your answer solely on the provided context.',
      '- If the context does not contain enough information to answer, say so plainly rather than guessing or drawing on outside knowledge.',
      '- Be concise and direct.',
      '- When you use information from a specific sentence, cite it by appending its ID in square brackets immediately after the claim, e.g. [c0_s1].',
      '- Only cite sentence IDs that appear exactly in the context below. Do not invent IDs.',
      '- A claim may cite multiple sentences: [c0_s1][c1_s0].',
      '- If no sentence directly supports a claim, do not cite.',
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

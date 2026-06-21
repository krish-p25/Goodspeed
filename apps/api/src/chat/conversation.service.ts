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
    resolvedCitations?: Array<{
      ids: string[]
      sentences: Array<{
        id: string
        documentTitle: string
        text: string
        charStart: number
        charEnd: number
      }>
      markerText: string
    }>
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

    // Persist citations as message_sources.
    // When span-level citations resolved during streaming, persist them with
    // their exact sentence text and character offsets. Otherwise fall back to
    // document-level rows — the guaranteed citation floor.
    if (params.resolvedCitations && params.resolvedCitations.length > 0) {
      const sentenceRows = params.resolvedCitations.flatMap(
        (citation, citationIndex) =>
          citation.sentences.map((sentence, sentenceIndex) => {
            // Find the chunk that owns this sentence ID
            const chunk = params.retrievedChunks.find((c) =>
              c.sentences.has(sentence.id),
            )
            return {
              message_id: assistantMsg.id,
              chunk_id: chunk?.id ?? null,
              document_id: chunk?.documentId ?? null,
              sentence_text: sentence.text,
              char_start: sentence.charStart,
              char_end: sentence.charEnd,
              position: citationIndex * 10 + sentenceIndex,
            }
          }),
      )

      if (sentenceRows.length > 0) {
        await admin.from('message_sources').insert(sentenceRows)
      }
    } else if (params.sources.length > 0) {
      // Document-level citations — accurate because they come from the known
      // retrieved chunks, not parsed from model output. position tracks
      // citation order within the message for stable numbering in the UI.
      const sourceRows = params.sources.map((source, position) => {
        // Find the first chunk for this document to get its ID
        const chunk = params.retrievedChunks.find(
          (c) => c.documentId === source.documentId,
        )
        return {
          message_id: assistantMsg.id,
          chunk_id: chunk?.id ?? null,
          document_id: source.documentId,
          sentence_text: '', // empty for document-level citations
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

  /**
   * List a user's conversations, most recently updated first.
   */
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

  /**
   * Fetch all messages for a conversation in chronological order.
   * Scoped to the owning user — returns empty if the conversation is not theirs.
   */
  async getMessages(conversationId: string, userId: string) {
    const admin = this.supabase.getAdminClient()

    // Verify ownership before returning messages
    const { data: conversation } = await admin
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single()

    if (!conversation) return []

    const { data, error } = await admin
      .from('messages')
      .select('id, conversation_id, user_id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)
    return data ?? []
  }
}

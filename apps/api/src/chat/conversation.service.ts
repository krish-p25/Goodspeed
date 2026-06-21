import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import type {
  RetrievedChunk,
  Message,
  MessageWithCitations,
  PersistedCitation,
  DocumentSource,
} from '@kb/types'

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

    // Persist citations as message_sources in two layers:
    //
    //   1. Document-level "floor" rows (empty sentence_text) for every
    //      retrieved source. Accurate because they come from the known
    //      retrieved chunks, not parsed from model output. These let the
    //      Sources footer be reconstructed faithfully on reload, even for
    //      retrieved documents the answer didn't end up citing.
    //   2. Span-level rows (non-empty sentence_text) for each resolved
    //      citation, carrying the exact cited sentence and offsets.
    //
    // Citation reconstruction keys off non-empty sentence_text, so the floor
    // rows are ignored there; the footer keys off distinct document_id, so it
    // sees both layers. The two are stored together without conflict.
    const rows: Array<{
      message_id: string
      chunk_id: string | null
      document_id: string | null
      sentence_text: string
      char_start: number | null
      char_end: number | null
      position: number
    }> = []

    params.sources.forEach((source, position) => {
      const chunk = params.retrievedChunks.find(
        (c) => c.documentId === source.documentId,
      )
      rows.push({
        message_id: assistantMsg.id,
        chunk_id: chunk?.id ?? null,
        document_id: source.documentId,
        sentence_text: '', // empty marks a document-level floor row
        char_start: null,
        char_end: null,
        position,
      })
    })

    if (params.resolvedCitations && params.resolvedCitations.length > 0) {
      params.resolvedCitations.forEach((citation, citationIndex) => {
        citation.sentences.forEach((sentence, sentenceIndex) => {
          const chunk = params.retrievedChunks.find((c) =>
            c.sentences.has(sentence.id),
          )
          rows.push({
            message_id: assistantMsg.id,
            chunk_id: chunk?.id ?? null,
            document_id: chunk?.documentId ?? null,
            sentence_text: sentence.text,
            char_start: sentence.charStart,
            char_end: sentence.charEnd,
            // Offset span positions past the floor rows so the two layers
            // never share a position within the message.
            position: 1000 + citationIndex * 10 + sentenceIndex,
          })
        })
      })
    }

    if (rows.length > 0) {
      await admin.from('message_sources').insert(rows)
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
   * Fetch all messages for a conversation in chronological order. Each
   * assistant message is enriched with its resolved span-level citations
   * (for inline badges) and its document-level sources (for the source
   * footer) so both survive a page reload.
   *
   * Scoped to the owning user — returns empty if the conversation is not theirs.
   */
  async getMessages(
    conversationId: string,
    userId: string,
  ): Promise<MessageWithCitations[]> {
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
    const messages = (data ?? []) as Message[]
    if (messages.length === 0) return []

    const extrasByMessage = await this.loadMessageExtras(
      messages.filter((m) => m.role === 'assistant').map((m) => m.id),
    )

    return messages.map((m) => {
      const extras = extrasByMessage.get(m.id)
      if (!extras) return m
      const enriched: MessageWithCitations = { ...m }
      if (extras.citations.length > 0) enriched.citations = extras.citations
      if (extras.sources.length > 0) enriched.sources = extras.sources
      return enriched
    })
  }

  /**
   * Delete a conversation owned by the user. Messages and message_sources
   * are removed automatically via ON DELETE CASCADE. Scoped by user_id so a
   * user can never delete another user's conversation.
   */
  async deleteConversation(
    conversationId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const admin = this.supabase.getAdminClient()
    const { error } = await admin
      .from('conversations')
      .delete()
      .eq('id', conversationId)
      .eq('user_id', userId)

    if (error) throw new Error(error.message)
    return { success: true }
  }

  /**
   * Load, per assistant message, both:
   *   - citations: span-level rows (non-empty sentence_text) grouped back
   *     into their original citations. The write-time position encoding
   *     (1000 + citationIndex * 10 + sentenceIndex) means floor(position / 10)
   *     recovers the citation a sentence belonged to.
   *   - sources: the distinct documents that informed the answer, derived
   *     from all rows (floor + span), in first-seen order.
   */
  private async loadMessageExtras(messageIds: string[]): Promise<
    Map<string, { citations: PersistedCitation[]; sources: DocumentSource[] }>
  > {
    const result = new Map<
      string,
      { citations: PersistedCitation[]; sources: DocumentSource[] }
    >()
    if (messageIds.length === 0) return result

    const admin = this.supabase.getAdminClient()
    const { data: sources } = await admin
      .from('message_sources')
      .select('id, message_id, document_id, sentence_text, position')
      .in('message_id', messageIds)
      .order('position', { ascending: true })

    const rows = (sources ?? []) as Array<{
      id: string
      message_id: string
      document_id: string | null
      sentence_text: string
      position: number
    }>

    // Resolve document titles in one query
    const documentIds = [
      ...new Set(rows.map((r) => r.document_id).filter((id): id is string => !!id)),
    ]
    const titleMap = new Map<string, string>()
    if (documentIds.length > 0) {
      const { data: docs } = await admin
        .from('documents')
        .select('id, title')
        .in('id', documentIds)
      for (const d of (docs ?? []) as Array<{ id: string; title: string }>) {
        titleMap.set(d.id, d.title)
      }
    }

    const titleFor = (documentId: string | null) =>
      documentId ? titleMap.get(documentId) ?? 'Unknown Document' : 'Unknown Document'

    // message -> citationIndex -> sentences
    const citationGroups = new Map<
      string,
      Map<number, PersistedCitation['sentences']>
    >()
    // message -> distinct documents (first-seen order)
    const sourceGroups = new Map<string, Map<string, DocumentSource>>()

    for (const row of rows) {
      // Source footer: collect every distinct document, floor or cited.
      if (row.document_id) {
        let docs = sourceGroups.get(row.message_id)
        if (!docs) {
          docs = new Map()
          sourceGroups.set(row.message_id, docs)
        }
        if (!docs.has(row.document_id)) {
          docs.set(row.document_id, {
            documentId: row.document_id,
            documentTitle: titleFor(row.document_id),
          })
        }
      }

      // Inline citations: only span rows (non-empty sentence_text).
      if (!row.sentence_text) continue
      const citationIndex = Math.floor(row.position / 10)
      let groups = citationGroups.get(row.message_id)
      if (!groups) {
        groups = new Map()
        citationGroups.set(row.message_id, groups)
      }
      const sentences = groups.get(citationIndex) ?? []
      sentences.push({
        id: row.id,
        documentTitle: titleFor(row.document_id),
        text: row.sentence_text,
      })
      groups.set(citationIndex, sentences)
    }

    for (const messageId of messageIds) {
      const groups = citationGroups.get(messageId)
      const citations: PersistedCitation[] = groups
        ? [...groups.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, sentences]) => ({ sentences }))
        : []
      const sources = [...(sourceGroups.get(messageId)?.values() ?? [])]
      if (citations.length > 0 || sources.length > 0) {
        result.set(messageId, { citations, sources })
      }
    }

    return result
  }
}

export const PLACEHOLDER = true;

export interface Document {
  id: string
  user_id: string
  title: string
  content: string
  tags: string[]
  created_at: string
  updated_at: string
}

export interface CreateDocumentDto {
  title: string
  content: string
  tags?: string[]
}

export interface UpdateDocumentDto {
  title?: string
  content?: string
  tags?: string[]
}

// ---------------------------------------------------------------------------
// AI Provider domain types
// Pure TypeScript — no imports from the openai package.
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: MessageRole
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
}

export interface ChatResult {
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface ChatChunk {
  delta: string
  done: boolean
}

export interface TextEvent {
  type: 'text'
  delta: string
}

export interface CitationEvent {
  type: 'citation'
  ids: string[]
}

export type StreamEvent = TextEvent | CitationEvent

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
  conversationId?: string
}

export interface ChatResponse {
  conversationId: string
  messageId: string
  answer: string
  sources: DocumentSource[]
  noContext: boolean
}

export interface DocumentSource {
  documentId: string
  documentTitle: string
}

// ---------------------------------------------------------------------------
// Retrieval types
// ---------------------------------------------------------------------------

/**
 * A single sentence within a retrieved chunk, with a stable ID for
 * citation purposes and character offsets into the source document
 * for click-through highlighting.
 */
export interface CitableSentence {
  id: string           // e.g. "c1_s3" — chunk position 1, sentence 3
  chunkId: string
  documentId: string
  documentTitle: string
  text: string
  charStart: number    // character offset into chunk.content
  charEnd: number
}

/**
 * A retrieved chunk with its similarity score and sentence-level citation
 * data pre-computed at retrieval time.
 */
export interface RetrievedChunk {
  id: string
  documentId: string
  documentTitle: string
  content: string
  chunkIndex: number
  similarity: number
  // Sentence map: id -> CitableSentence
  // Populated at retrieval time for use by the citation resolver in Phase 9
  sentences: Map<string, CitableSentence>
}

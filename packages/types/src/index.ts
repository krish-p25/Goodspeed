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

/**
 * A single resolved citation as reconstructed for a persisted message.
 * One citation may group several sentences (a chained marker like
 * [c0_s1][c1_s0]). Ordered by appearance within the message so the
 * frontend can zip them positionally against the markers left in the
 * answer text.
 */
export interface PersistedCitation {
  sentences: Array<{ id: string; documentTitle: string; text: string }>
}

/**
 * A stored message plus the data needed to re-render its citations and
 * source footer after a reload. Both fields are present only for assistant
 * messages — citations for inline badges, sources for the document footer.
 */
export interface MessageWithCitations extends Message {
  citations?: PersistedCitation[]
  sources?: DocumentSource[]
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
// SSE streaming event types
// These are the typed events emitted by POST /chat/stream
// ---------------------------------------------------------------------------

export type SseEventType = 'token' | 'sources' | 'done' | 'error'

export interface TokenEvent {
  type: 'token'
  delta: string // the new token text
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

// Citation event emitted by the SSE stream when a valid citation marker
// is resolved. Carries the resolved sentence data for frontend rendering.
export interface CitationStreamEvent {
  type: 'citation'
  ids: string[]           // the validated sentence IDs e.g. ["c0_s1", "c1_s0"]
  sentences: Array<{
    id: string
    documentTitle: string
    text: string            // the exact cited sentence
    charStart: number
    charEnd: number
  }>
  // The original marker text e.g. "[c0_s1]" — used by the frontend to
  // replace the marker with a highlighted span.
  markerText: string
}

export type ChatSseEvent =
  | TokenEvent
  | CitationStreamEvent
  | SourcesEvent
  | DoneEvent
  | ErrorEvent

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

// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

export type ProviderName = 'openai' | 'groq' | 'together' | 'ollama' | 'mock'

export interface ProviderBlock {
  provider: ProviderName
  baseUrl: string
  model: string
}

export interface AiConfigSettings {
  chat: ProviderBlock
  embedding: ProviderBlock
  chunking: {
    targetTokens: number
    overlapFraction: number
  }
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

// ---------------------------------------------------------------------------
// Token usage types
// ---------------------------------------------------------------------------

export type TokenUsagePeriod = 'today' | 'week' | 'month'
export type TokenUsageType = 'chat' | 'embedding'

export interface TokenUsageRow {
  id: string
  user_id: string
  type: TokenUsageType
  conversation_id: string | null
  message_id: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number
  model: string | null
  created_at: string
}

// One data point in the time-series chart.
// label: x-axis label (hour "14", day name "Mon", or date "15")
// chatTokens: cumulative chat tokens up to this point in the period
// embeddingTokens: cumulative embedding tokens up to this point
export interface UsageDataPoint {
  label: string // compact axis tick, e.g. "22", "Mon", "14:00"
  fullLabel: string // full label for the tooltip header, e.g. "22 June", "Monday", "14:00"
  chatTokens: number
  embeddingTokens: number
  totalTokens: number
}

export interface UsageAggregate {
  chatPromptTokens: number
  chatCompletionTokens: number
  chatTotalTokens: number
  chatCallCount: number
  embeddingTotalTokens: number
  embeddingCallCount: number
  grandTotalTokens: number
}

export interface ConversationUsage {
  conversationId: string
  conversationTitle: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  messageCount: number
}

export interface UsageSummary {
  period: TokenUsagePeriod
  periodLabel: string           // e.g. "Today", "This week", "June 2026"
  series: UsageDataPoint[]      // time-series for the line chart
  aggregate: UsageAggregate
  byConversation: ConversationUsage[]
}

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

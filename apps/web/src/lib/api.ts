import { createClient } from '@/lib/supabase/server'
import type {
  Document as KBDocument,
  ChatResponse,
  Conversation,
  MessageWithCitations,
  AiConfigSettings,
} from '@kb/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getAccessToken(): Promise<string> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not authenticated')
  return token
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken()
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API error ${res.status}: ${body}`)
  }
  return res.json()
}

export const documentsApi = {
  list: () =>
    apiFetch<KBDocument[]>('/documents'),

  get: (id: string) =>
    apiFetch<KBDocument>(`/documents/${id}`),

  create: (body: { title: string; content: string; tags?: string[] }) =>
    apiFetch<KBDocument>('/documents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  update: (id: string, body: { title?: string; content?: string; tags?: string[] }) =>
    apiFetch<KBDocument>(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  delete: (id: string) =>
    apiFetch<{ success: boolean }>(`/documents/${id}`, {
      method: 'DELETE',
    }),
}

export const chatApi = {
  send: (body: { question: string; conversationId?: string }) =>
    apiFetch<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listConversations: () =>
    apiFetch<Conversation[]>('/chat/conversations'),

  getMessages: (conversationId: string) =>
    apiFetch<MessageWithCitations[]>(
      `/chat/conversations/${conversationId}/messages`,
    ),
}

export const settingsApi = {
  get: () => apiFetch<AiConfigSettings>('/settings'),

  update: (settings: AiConfigSettings) =>
    apiFetch<{ success: boolean; message: string }>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }),
}


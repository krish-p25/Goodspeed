import { chatApi } from '@/lib/api'
import { ChatWindow } from '../chat-window'
import type { MessageWithCitations } from '@kb/types'

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>
}) {
  const { conversationId } = await params

  let messages: MessageWithCitations[] = []
  try {
    messages = await chatApi.getMessages(conversationId)
  } catch {
    messages = []
  }

  return (
    <ChatWindow conversationId={conversationId} initialMessages={messages} />
  )
}

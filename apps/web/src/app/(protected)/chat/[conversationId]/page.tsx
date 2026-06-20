import { chatApi } from '@/lib/api'
import { ChatWindow } from '../chat-window'
import type { Message } from '@kb/types'

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>
}) {
  const { conversationId } = await params

  let messages: Message[] = []
  try {
    messages = await chatApi.getMessages(conversationId)
  } catch {
    messages = []
  }

  return (
    <ChatWindow conversationId={conversationId} initialMessages={messages} />
  )
}

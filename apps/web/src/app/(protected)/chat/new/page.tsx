import { ChatWindow } from '../chat-window'

export default function NewChatPage() {
  // No conversationId yet — the conversation is created on the first message,
  // at which point ChatWindow captures the returned ID and updates the URL.
  return <ChatWindow initialMessages={[]} />
}

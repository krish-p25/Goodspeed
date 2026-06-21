import Link from 'next/link'
import { chatApi } from '@/lib/api'
import { buttonVariants } from '@/components/ui/button'
import { MessageSquarePlus, LayoutDashboard, FolderOpen, MessageSquare } from 'lucide-react'
import type { Conversation } from '@kb/types'
import { ConversationList } from './conversation-list'

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let conversations: Conversation[] = []
  try {
    conversations = await chatApi.listConversations()
  } catch {
    conversations = []
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="border-b border-border bg-background px-4 sm:px-6 py-3 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <MessageSquare className="size-4" />
          </span>
          <h1 className="text-lg font-bold">Chat</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/documents" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <FolderOpen className="size-4" />
            <span className="hidden sm:inline">Documents</span>
          </Link>
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <LayoutDashboard className="size-4" />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Conversation sidebar */}
        <aside className="w-64 border-r border-border bg-muted/20 flex flex-col shrink-0 hidden md:flex">
          <div className="p-3">
            <Link
              href="/chat/new"
              className={buttonVariants({ variant: 'default', className: 'w-full' })}
            >
              <MessageSquarePlus className="size-4" />
              New Chat
            </Link>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
            <ConversationList conversations={conversations} />
          </nav>
        </aside>

        {/* Mobile new-chat bar */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="md:hidden border-b border-border p-2">
            <Link
              href="/chat/new"
              className={buttonVariants({ variant: 'default', size: 'sm', className: 'w-full' })}
            >
              <MessageSquarePlus className="size-4" />
              New Chat
            </Link>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

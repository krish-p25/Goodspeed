import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { MessageSquarePlus, MessageSquare } from 'lucide-react'

export default function ChatIndexPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
      <MessageSquare className="size-12 text-muted-foreground/40 mb-4" />
      <h2 className="text-lg font-semibold">Start a conversation</h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        Ask questions and get answers grounded in your own documents. Pick a past
        conversation from the sidebar or start a new one.
      </p>
      <Link href="/chat/new" className={buttonVariants({ variant: 'default', className: 'mt-5' })}>
        <MessageSquarePlus className="size-4" />
        New Chat
      </Link>
    </div>
  )
}

'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { buttonVariants } from '@/components/ui/button'
import { MessageSquarePlus, Menu, X } from 'lucide-react'
import type { Conversation } from '@kb/types'
import { ConversationList } from './conversation-list'

/**
 * Mobile (< md) chat navigation. The desktop sidebar is hidden on small
 * screens, so this provides the equivalent access: a top bar with "New Chat"
 * plus a button that opens the conversation list in a slide-over drawer.
 */
export function MobileChatBar({
  conversations,
}: {
  conversations: Conversation[]
}) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Close the drawer whenever the route changes (a conversation was opened).
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Lock body scroll while the drawer is open, and close on Escape.
  useEffect(() => {
    if (!open) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = original
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="md:hidden">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-border p-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          aria-label="Show conversations"
        >
          <Menu className="size-4" />
          Chats
        </button>
        <Link
          href="/chat/new"
          className={buttonVariants({
            variant: 'default',
            size: 'sm',
            className: 'flex-1',
          })}
        >
          <MessageSquarePlus className="size-4" />
          New Chat
        </Link>
      </div>

      {/* Slide-over drawer */}
      {open && (
        <div
          className="fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Conversations"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[80%] flex-col border-r border-border bg-background shadow-xl">
            <div className="flex items-center justify-between border-b border-border p-3">
              <span className="text-sm font-semibold">Conversations</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close conversations"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="p-3">
              <Link
                href="/chat/new"
                className={buttonVariants({
                  variant: 'default',
                  className: 'w-full',
                })}
              >
                <MessageSquarePlus className="size-4" />
                New Chat
              </Link>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
              <ConversationList conversations={conversations} />
            </nav>
          </div>
        </div>
      )}
    </div>
  )
}

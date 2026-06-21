'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Trash2, Loader2, AlertTriangle } from 'lucide-react'
import type { Conversation } from '@kb/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getToken(): Promise<string> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

export function ConversationList({
  conversations,
}: {
  conversations: Conversation[]
}) {
  const pathname = usePathname()
  const router = useRouter()
  // The conversation awaiting delete confirmation, if any.
  const [pending, setPending] = useState<Conversation | null>(null)
  const [deleting, setDeleting] = useState(false)

  const requestDelete = (
    e: React.MouseEvent<HTMLButtonElement>,
    conversation: Conversation,
  ) => {
    // Stop the click from following the surrounding link.
    e.preventDefault()
    e.stopPropagation()
    setPending(conversation)
  }

  const cancelDelete = () => {
    if (deleting) return
    setPending(null)
  }

  const confirmDelete = async () => {
    if (!pending || deleting) return
    const id = pending.id

    setDeleting(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/chat/conversations/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)

      setPending(null)
      // Leave the conversation view if we just deleted the one being viewed.
      if (pathname === `/chat/${id}`) {
        router.push('/chat')
      }
      // Refresh the server-rendered sidebar so the item disappears.
      router.refresh()
    } catch {
      // Keep the modal open so the user can retry.
    } finally {
      setDeleting(false)
    }
  }

  if (conversations.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-2 py-4 text-center">
        No conversations yet.
      </p>
    )
  }

  return (
    <>
      {conversations.map((c) => {
        const active = pathname === `/chat/${c.id}`
        return (
          <div key={c.id} className="group relative">
            <Link
              href={`/chat/${c.id}`}
              className={cn(
                'block rounded-md py-2 pl-3 pr-9 text-sm truncate transition-colors',
                active
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
              title={c.title ?? 'Untitled'}
            >
              {c.title ?? 'Untitled conversation'}
            </Link>
            <button
              type="button"
              onClick={(e) => requestDelete(e, c)}
              aria-label="Delete conversation"
              className={cn(
                'absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-opacity',
                'hover:bg-destructive/10 hover:text-destructive',
                'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
              )}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )
      })}

      {pending && (
        <ConfirmDeleteModal
          title={pending.title ?? 'Untitled conversation'}
          deleting={deleting}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        />
      )}
    </>
  )
}

function ConfirmDeleteModal({
  title,
  deleting,
  onCancel,
  onConfirm,
}: {
  title: string
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-conversation-title"
    >
      {/* Backdrop — click to dismiss */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      <div className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" />
          </span>
          <div className="min-w-0">
            <h2
              id="delete-conversation-title"
              className="text-base font-semibold text-foreground"
            >
              Delete conversation?
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              &ldquo;<span className="font-medium text-foreground">{title}</span>
              &rdquo; and all of its messages will be permanently deleted. This
              cannot be undone.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            {deleting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete
          </Button>
        </div>
      </div>
    </div>
  )
}

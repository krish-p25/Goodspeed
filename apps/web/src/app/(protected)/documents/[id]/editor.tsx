'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import { Save, Loader2, LayoutDashboard, FolderOpen } from 'lucide-react'
import type { Document as KBDocument } from '@kb/types'

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false })

const API_URL = process.env.NEXT_PUBLIC_API_URL
const AUTOSAVE_DELAY = 3000

async function getToken(): Promise<string> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

async function patchDocument(
  id: string,
  title: string,
  content: string,
  tags: string,
) {
  const token = await getToken()
  const res = await fetch(`${API_URL}/documents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title,
      content,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    }),
  })
  if (!res.ok) throw new Error('Save failed')
}

type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export function DocumentEditor({ document }: { document: KBDocument }) {
  const router = useRouter()
  const [title, setTitle] = useState(document.title)
  const [content, setContent] = useState(document.content)
  const [tags, setTags] = useState(document.tags.join(', '))
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  // Always-current snapshot so timer callbacks read latest values without
  // needing them as effect dependencies.
  const snapshot = useRef({ title, content, tags })
  useEffect(() => { snapshot.current = { title, content, tags } }, [title, content, tags])

  const isFirstRender = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSave = useCallback(async (t: string, c: string, tg: string) => {
    setStatus('saving')
    setSaveError(null)
    try {
      await patchDocument(document.id, t, c, tg)
      setStatus('saved')
      router.refresh()
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000)
    } catch (e: unknown) {
      setStatus('error')
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    }
  }, [document.id, router])

  // Auto-save: debounce 3 s after last keystroke
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    setStatus('pending')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const { title: t, content: c, tags: tg } = snapshot.current
      doSave(t, c, tg)
    }, AUTOSAVE_DELAY)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [title, content, tags, doSave])

  const handleManualSave = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const { title: t, content: c, tags: tg } = snapshot.current
    doSave(t, c, tg)
  }

  const isSaving = status === 'saving'

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Sticky header with breadcrumb and save controls */}
      <header className="sticky top-0 z-10 border-b border-border bg-background px-6 py-3 flex items-center justify-between gap-4">
        <nav className="flex items-center gap-1.5 text-sm min-w-0">
          <Link
            href="/dashboard"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <LayoutDashboard className="size-4" />
            Dashboard
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link
            href="/documents"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <FolderOpen className="size-4" />
            Documents
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium text-foreground truncate">
            {title || 'Untitled'}
          </span>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {status === 'pending' && (
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
          )}
          {isSaving && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Saving…
            </span>
          )}
          {status === 'saved' && (
            <span className="text-xs text-green-600">Saved</span>
          )}
          {status === 'error' && (
            <span className="text-xs text-destructive">{saveError}</span>
          )}
          <Button size="sm" onClick={handleManualSave} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
        </div>
      </header>

      {/* Document body */}
      <div className="flex-1 flex flex-col gap-4 px-8 py-6 max-w-4xl mx-auto w-full">
        {/* Timestamps */}
        <div className="flex gap-6 text-xs text-muted-foreground">
          <span>Created: {new Date(document.created_at).toLocaleString()}</span>
          <span>Updated: {new Date(document.updated_at).toLocaleString()}</span>
        </div>

        {/* Title — plain input styled as heading */}
        <input
          className="w-full text-2xl font-bold bg-transparent outline-none border-b border-border pb-2 placeholder:text-muted-foreground text-foreground"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Document title"
        />

        {/* Tags */}
        <Input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="Tags (comma separated)"
        />

        {/* Markdown editor */}
        <MDEditor
          value={content}
          onChange={(val) => setContent(val ?? '')}
          height={500}
        />
      </div>
    </div>
  )
}

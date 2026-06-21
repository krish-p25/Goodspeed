'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import {
  Save,
  Loader2,
  LayoutDashboard,
  FolderOpen,
  FileUp,
  FileText,
  Tag,
  AlertCircle,
} from 'lucide-react'
import type { Document as KBDocument } from '@kb/types'

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false })

const API_URL = process.env.NEXT_PUBLIC_API_URL
const AUTOSAVE_DELAY = 2000

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

  // Auto-save: debounce 2 s after last keystroke
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

  // --- PDF import ---------------------------------------------------------
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const handlePdfSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so the same file can be re-selected
    if (!file) return

    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) {
      setImportError('Please choose a PDF file.')
      return
    }

    setImporting(true)
    setImportError(null)
    setImportMsg(`Extracting text from ${file.name}…`)
    try {
      const token = await getToken()
      const form = new FormData()
      form.append('file', file)

      const res = await fetch(`${API_URL}/documents/extract-pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.message ?? `Extraction failed (${res.status})`)
      }

      const { markdown } = (await res.json()) as { markdown: string }

      if (!markdown?.trim()) {
        setImportError(
          'No selectable text found — this PDF may be scanned images.',
        )
        return
      }

      // Append to existing content (with spacing) or seed an empty document.
      setContent((prev) =>
        prev.trim() ? `${prev.trimEnd()}\n\n${markdown}` : markdown,
      )
      // Name the document after the file if it's still the default/empty title.
      setTitle((t) =>
        !t.trim() || t === 'Untitled Document'
          ? file.name.replace(/\.pdf$/i, '')
          : t,
      )
      setImportMsg(null)
    } catch (err: unknown) {
      setImportError(
        err instanceof Error ? err.message : 'Failed to read PDF.',
      )
    } finally {
      setImporting(false)
    }
  }

  const isSaving = status === 'saving'

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Sticky header with breadcrumb and save controls */}
      <header className="sticky top-0 z-10 border-b border-border bg-background px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <nav className="flex items-center gap-1 sm:gap-1.5 text-sm min-w-0">
          <Link
            href="/dashboard"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Dashboard"
          >
            <LayoutDashboard className="size-4" />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link
            href="/documents"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Documents"
          >
            <FolderOpen className="size-4" />
            <span className="hidden sm:inline">Documents</span>
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium text-foreground truncate">
            {title || 'Untitled'}
          </span>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Autosave indicator — always visible on sm+ */}
          <span className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground border border-border rounded-md px-2 py-1 select-none">
            <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
            Autosave: On
          </span>

          {status === 'pending' && (
            <span className="text-xs text-muted-foreground hidden sm:inline">Unsaved changes</span>
          )}
          {isSaving && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="hidden sm:inline">Saving…</span>
            </span>
          )}
          {status === 'saved' && (
            <span className="text-xs text-emerald-600 hidden sm:inline">Saved</span>
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
      <div className="flex-1 px-4 sm:px-8 py-5 sm:py-8 max-w-4xl mx-auto w-full">
        <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
          {/* Title zone */}
          <div className="border-b border-border bg-gradient-to-br from-primary/5 to-transparent p-5 sm:p-6 space-y-4">
            <input
              className="w-full text-2xl sm:text-3xl font-bold bg-transparent outline-none placeholder:text-muted-foreground/60 text-foreground"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled document"
            />

            <div className="flex items-center gap-2.5">
              <Tag className="size-4 text-muted-foreground shrink-0" />
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Add tags, comma separated"
                className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 h-8"
              />
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>Created {new Date(document.created_at).toLocaleString()}</span>
              <span>Updated {new Date(document.updated_at).toLocaleString()}</span>
            </div>
          </div>

          {/* Editor toolbar */}
          <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-2.5 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FileText className="size-4" />
              <span>Markdown</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={handlePdfSelected}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              title="Extract text from a PDF into this document"
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FileUp className="size-4" />
              )}
              {importing ? 'Importing…' : 'Import PDF'}
            </Button>
          </div>

          {/* Import status row */}
          {(importing || importError) && (
            <div
              className={`flex items-center gap-2 px-5 sm:px-6 py-2.5 border-b border-border text-sm ${
                importError
                  ? 'text-destructive bg-destructive/5'
                  : 'text-muted-foreground bg-primary/5'
              }`}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin shrink-0" />
              ) : (
                <AlertCircle className="size-4 shrink-0" />
              )}
              <span>{importing ? importMsg : importError}</span>
            </div>
          )}

          {/* Markdown editor */}
          <div data-color-mode="light">
            <MDEditor
              value={content}
              onChange={(val) => setContent(val ?? '')}
              height={520}
              className="!border-0 !rounded-none !shadow-none"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { deleteDocument, deleteDocuments } from './actions'
import { Eye, Trash2, Loader2 } from 'lucide-react'
import type { Document as KBDocument } from '@kb/types'

type ConfirmState =
  | { open: false }
  | { open: true; mode: 'single'; id: string; title: string }
  | { open: true; mode: 'bulk'; ids: string[] }

export function DocumentsTable({ documents }: { documents: KBDocument[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<ConfirmState>({ open: false })
  const [isDeleting, setIsDeleting] = useState(false)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const allSelected = documents.length > 0 && selected.size === documents.length

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(documents.map((d) => d.id)))

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const handleView = (id: string) => {
    setViewingId(id)
    startTransition(() => { router.push(`/documents/${id}`) })
  }

  const handleDeleteClick = (doc: KBDocument) =>
    setConfirm({ open: true, mode: 'single', id: doc.id, title: doc.title })

  const handleBulkDeleteClick = () =>
    setConfirm({ open: true, mode: 'bulk', ids: Array.from(selected) })

  const closeConfirm = () => { if (!isDeleting) setConfirm({ open: false }) }

  const handleConfirmedDelete = async () => {
    if (!confirm.open) return
    setIsDeleting(true)
    try {
      if (confirm.mode === 'single') {
        await deleteDocument(confirm.id)
      } else {
        await deleteDocuments(confirm.ids)
        setSelected(new Set())
      }
      setConfirm({ open: false })
      router.refresh()
    } finally {
      setIsDeleting(false)
    }
  }

  if (documents.length === 0) {
    return (
      <div className="rounded-lg border border-border p-12 text-center text-muted-foreground">
        No documents yet. Click &ldquo;New Document&rdquo; to get started.
      </div>
    )
  }

  return (
    <>
      <div className="rounded-lg border border-border overflow-hidden">
        {/* Bulk action toolbar — visible when rows are checked */}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-muted/60 border-b border-border">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <Button variant="destructive" size="sm" onClick={handleBulkDeleteClick}>
              <Trash2 className="size-3.5" />
              Delete Selected
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {/* ── Mobile card list (< md) ── */}
        <div className="md:hidden divide-y divide-border">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className={`p-4 transition-colors ${selected.has(doc.id) ? 'bg-muted/30' : ''}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 cursor-pointer rounded"
                  checked={selected.has(doc.id)}
                  onChange={() => toggleOne(doc.id)}
                  aria-label={`Select ${doc.title}`}
                />
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/documents/${doc.id}`}
                    className="font-medium text-foreground hover:underline line-clamp-2 block"
                  >
                    {doc.title || 'Untitled'}
                  </Link>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Updated {new Date(doc.updated_at).toLocaleString()}
                  </p>
                  {doc.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {doc.tags.map((tag) => (
                        <Badge key={tag} variant="secondary">{tag}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={viewingId === doc.id && isPending}
                    onClick={() => handleView(doc.id)}
                    aria-label="View"
                  >
                    {viewingId === doc.id && isPending
                      ? <Loader2 className="size-3.5 animate-spin" />
                      : <Eye className="size-3.5" />}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDeleteClick(doc)}
                    aria-label="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Desktop table (md+) ── */}
        <table className="hidden md:table w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="w-10 px-4 py-3 text-left">
                <input
                  type="checkbox"
                  className="cursor-pointer rounded"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th className="px-4 py-3 text-left font-semibold text-foreground">Title</th>
              <th className="px-4 py-3 text-left font-semibold text-foreground hidden lg:table-cell">Tags</th>
              <th className="px-4 py-3 text-left font-semibold text-foreground whitespace-nowrap hidden lg:table-cell">Created</th>
              <th className="px-4 py-3 text-left font-semibold text-foreground whitespace-nowrap">Last Updated</th>
              <th className="px-4 py-3 text-right font-semibold text-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr
                key={doc.id}
                className={`border-b border-border last:border-0 transition-colors hover:bg-muted/20 ${
                  selected.has(doc.id) ? 'bg-muted/30' : ''
                }`}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    className="cursor-pointer rounded"
                    checked={selected.has(doc.id)}
                    onChange={() => toggleOne(doc.id)}
                    aria-label={`Select ${doc.title}`}
                  />
                </td>
                <td className="px-4 py-3 max-w-xs">
                  <Link
                    href={`/documents/${doc.id}`}
                    className="font-medium text-foreground hover:underline truncate block"
                  >
                    {doc.title}
                  </Link>
                </td>
                <td className="px-4 py-3 hidden lg:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {doc.tags.length > 0
                      ? doc.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">{tag}</Badge>
                        ))
                      : <span className="text-muted-foreground">—</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap hidden lg:table-cell">
                  {new Date(doc.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                  {new Date(doc.updated_at).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={viewingId === doc.id && isPending}
                      onClick={() => handleView(doc.id)}
                    >
                      {viewingId === doc.id && isPending
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : <Eye className="size-3.5" />}
                      {viewingId === doc.id && isPending ? 'Loading…' : 'View'}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDeleteClick(doc)}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Confirmation modal ── */}
      {confirm.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeConfirm() }}
        >
          <div className="bg-background rounded-xl border border-border shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-semibold text-foreground mb-1">
              {confirm.mode === 'bulk'
                ? `Delete ${confirm.ids.length} document${confirm.ids.length !== 1 ? 's' : ''}?`
                : 'Delete document?'}
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              {confirm.mode === 'single'
                ? `"${confirm.title}" will be permanently deleted. This action cannot be undone.`
                : `${confirm.ids.length} selected document${confirm.ids.length !== 1 ? 's' : ''} will be permanently deleted. This action cannot be undone.`}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={isDeleting} onClick={closeConfirm}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isDeleting}
                onClick={handleConfirmedDelete}
              >
                {isDeleting
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <Trash2 className="size-3.5" />}
                {isDeleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

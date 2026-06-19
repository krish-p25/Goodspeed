'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { deleteDocument } from './actions'
import { Eye, Trash2, Loader2 } from 'lucide-react'
import type { Document as KBDocument } from '@kb/types'

export function DocumentsTable({ documents }: { documents: KBDocument[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const allSelected = documents.length > 0 && selected.size === documents.length

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(documents.map((d) => d.id)))

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      await deleteDocument(id)
      router.refresh()
    } finally {
      setDeletingId(null)
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
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
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
            <th className="px-4 py-3 text-left font-semibold text-foreground">Tags</th>
            <th className="px-4 py-3 text-left font-semibold text-foreground whitespace-nowrap">Created</th>
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
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {doc.tags.length > 0
                    ? doc.tags.map((tag) => (
                        <Badge key={tag} variant="secondary">{tag}</Badge>
                      ))
                    : <span className="text-muted-foreground">—</span>}
                </div>
              </td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                {new Date(doc.created_at).toLocaleString()}
              </td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                {new Date(doc.updated_at).toLocaleString()}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-2">
                  <Link
                    href={`/documents/${doc.id}`}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    <Eye className="size-3.5" />
                    View
                  </Link>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={deletingId === doc.id}
                    onClick={() => handleDelete(doc.id)}
                  >
                    {deletingId === doc.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

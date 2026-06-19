import { documentsApi } from '@/lib/api'
import { NewDocumentButton } from './new-document-button'
import { DocumentsTable } from './documents-table'
import { buttonVariants } from '@/components/ui/button'
import Link from 'next/link'
import { LayoutDashboard } from 'lucide-react'
import type { Document as KBDocument } from '@kb/types'

export default async function DocumentsPage() {
  let documents: KBDocument[] = []
  try {
    documents = await documentsApi.list()
  } catch {
    documents = []
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-background px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">My Documents</h1>
          <p className="text-sm text-muted-foreground">
            {documents.length} document{documents.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>
            <LayoutDashboard className="size-4" />
            Dashboard
          </Link>
          <NewDocumentButton />
        </div>
      </header>
      <main className="flex-1 p-6">
        <DocumentsTable documents={documents} />
      </main>
    </div>
  )
}

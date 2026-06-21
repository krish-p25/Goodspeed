import { documentsApi } from '@/lib/api'
import { NewDocumentButton } from './new-document-button'
import { DocumentsTable } from './documents-table'
import { buttonVariants } from '@/components/ui/button'
import Link from 'next/link'
import { LayoutDashboard, MessageSquare } from 'lucide-react'
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
      <header className="border-b border-border bg-background px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">My Documents</h1>
          <p className="text-sm text-muted-foreground">
            {documents.length} document{documents.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/chat" className={buttonVariants({ variant: 'default' })}>
            <MessageSquare className="size-4" />
            <span className="hidden sm:inline">Chat</span>
          </Link>
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>
            <LayoutDashboard className="size-4" />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
          <NewDocumentButton />
        </div>
      </header>
      <main className="flex-1 p-3 sm:p-6">
        <DocumentsTable documents={documents} />
      </main>
    </div>
  )
}

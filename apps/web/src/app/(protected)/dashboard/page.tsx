import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { signOut } from './actions'
import { Button, buttonVariants } from '@/components/ui/button'
import Link from 'next/link'
import { FileText, LogOut, FilePlus } from 'lucide-react'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  if (!data?.claims) redirect('/login')

  const email = data.claims.email as string

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-background px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground truncate max-w-[200px] sm:max-w-none">
            {email}
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/documents" className={buttonVariants({ variant: 'default' })}>
            <FileText className="size-4" />
            <span className="hidden sm:inline">My Documents</span>
          </Link>
          <form action={signOut}>
            <Button type="submit" variant="outline">
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </Button>
          </form>
        </div>
      </header>

      <main className="flex-1 p-4 sm:p-6 max-w-2xl mx-auto w-full space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Welcome back</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Your personal AI-powered knowledge base.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/documents"
            className="rounded-lg border border-border bg-background p-5 hover:bg-muted/40 transition-colors space-y-2"
          >
            <FileText className="size-6 text-muted-foreground" />
            <p className="font-medium text-sm">My Documents</p>
            <p className="text-xs text-muted-foreground">
              Browse, search, and manage your knowledge base.
            </p>
          </Link>

          <Link
            href="/documents"
            className="rounded-lg border border-border bg-background p-5 hover:bg-muted/40 transition-colors space-y-2"
          >
            <FilePlus className="size-6 text-muted-foreground" />
            <p className="font-medium text-sm">New Document</p>
            <p className="text-xs text-muted-foreground">
              Add new content to your knowledge base.
            </p>
          </Link>
        </div>
      </main>
    </div>
  )
}

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { signOut } from './actions'
import { Button, buttonVariants } from '@/components/ui/button'
import Link from 'next/link'
import { FileText, LogOut } from 'lucide-react'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  if (!data?.claims) redirect('/login')

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-background px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{data.claims.email as string}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/documents" className={buttonVariants({ variant: 'default' })}>
            <FileText className="size-4" />
            My Documents
          </Link>
          <form action={signOut}>
            <Button type="submit" variant="outline">
              <LogOut className="size-4" />
              Sign Out
            </Button>
          </form>
        </div>
      </header>
      <main className="flex-1 flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          Welcome back. Use the navigation above to manage your documents.
        </p>
      </main>
    </div>
  )
}

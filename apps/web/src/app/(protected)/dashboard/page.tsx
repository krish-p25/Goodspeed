import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { signOut } from './actions'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: claimsData } = await supabase.auth.getClaims()

  if (!claimsData?.claims) redirect('/login')

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <h1 className="mb-4 text-2xl font-bold">Dashboard</h1>
        <p className="mb-6 text-gray-600">
          Signed in as: <span className="font-medium">{claimsData.claims.email as string}</span>
        </p>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  )
}

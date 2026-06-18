import { signUp } from './actions'

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-2xl font-bold">Create account</h1>

        {error && (
          <p className="mb-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</p>
        )}

        <form action={signUp} className="flex flex-col gap-4">
          <input
            name="email"
            type="email"
            placeholder="Email"
            required
            className="rounded border px-3 py-2"
          />
          <input
            name="password"
            type="password"
            placeholder="Password"
            required
            className="rounded border px-3 py-2"
          />
          <button
            type="submit"
            className="rounded bg-black px-4 py-2 text-white hover:bg-gray-800"
          >
            Create account
          </button>
        </form>

        <p className="mt-4 text-sm text-gray-600">
          Already have an account?{' '}
          <a href="/login" className="underline">
            Sign in
          </a>
        </p>
      </div>
    </main>
  )
}

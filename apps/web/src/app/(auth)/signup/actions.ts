'use server'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export async function signUp(formData: FormData) {
  const supabase = await createClient()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3020'
  const { data, error } = await supabase.auth.signUp({
    email: formData.get('email') as string,
    password: formData.get('password') as string,
    options: {
      emailRedirectTo: `${siteUrl}/auth/callback`,
    },
  })
  if (error) redirect('/signup?error=' + encodeURIComponent(error.message))
  // Session present means email confirmation is disabled — user is auto-confirmed
  if (data.session) redirect('/dashboard')
  redirect('/login?message=Check your email to confirm your account')
}

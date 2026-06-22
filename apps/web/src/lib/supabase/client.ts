import { createBrowserClient } from '@supabase/ssr'
import { getSupabaseUrl } from './config'

export function createClient() {
  return createBrowserClient(
    getSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

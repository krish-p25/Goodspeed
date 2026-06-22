import { ConfigService } from '@nestjs/config'

/**
 * Derive the Supabase project URL from the configured project ref, e.g.
 * ref "abcdxyz" -> "https://abcdxyz.supabase.co". Both apps configure a single
 * NEXT_PUBLIC_SUPABASE_PROJECT_REF; the full REST URL and the auth JWKS
 * endpoint are derived from it rather than stored as separate variables.
 */
export function getSupabaseUrl(config: ConfigService): string {
  const ref = config.getOrThrow<string>('NEXT_PUBLIC_SUPABASE_PROJECT_REF')
  return `https://${ref}.supabase.co`
}

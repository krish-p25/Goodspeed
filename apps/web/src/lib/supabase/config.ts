/**
 * Derive the Supabase project URL from the project ref so only the ref needs
 * to be configured. The ref is the subdomain of your project URL shown in the
 * Supabase dashboard, e.g. ref "abcdxyz" -> "https://abcdxyz.supabase.co".
 *
 * The auth JWKS endpoint and the REST URL are both derived from this, so a
 * single NEXT_PUBLIC_SUPABASE_PROJECT_REF is the only Supabase URL config.
 */
export function getSupabaseUrl(): string {
  const ref = process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF
  if (!ref) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_PROJECT_REF is not set — add your Supabase project ref to .env',
    )
  }
  return `https://${ref}.supabase.co`
}

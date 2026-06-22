import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseUrl } from './supabase-url'

@Injectable()
export class SupabaseService {
  private readonly adminClient: SupabaseClient

  constructor(private config: ConfigService) {
    // Admin client: bypasses RLS. Use only for operations that legitimately
    // need elevated access (e.g. writing embeddings in Phase 5).
    this.adminClient = createClient(
      getSupabaseUrl(this.config),
      this.config.getOrThrow('SUPABASE_SECRET_KEY'),
      { auth: { persistSession: false } },
    )
  }

  /** Admin client: bypasses RLS. Keep usage minimal and intentional. */
  getAdminClient(): SupabaseClient {
    return this.adminClient
  }

  /**
   * Creates a per-request user-scoped client. Initialised with the user
   * access token so PostgREST runs queries as that user and RLS applies.
   */
  getUserClient(accessToken: string): SupabaseClient {
    return createClient(
      getSupabaseUrl(this.config),
      this.config.getOrThrow('SUPABASE_SECRET_KEY'),
      {
        auth: { persistSession: false },
        global: {
          headers: { Authorization: 'Bearer ' + accessToken },
        },
      },
    )
  }
}

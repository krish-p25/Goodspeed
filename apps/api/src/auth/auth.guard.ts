import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createClient } from '@supabase/supabase-js'

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()

    const authHeader = request.headers['authorization'] as string | undefined
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header')
    }
    const accessToken = authHeader.slice(7)

    // Verify JWT via getClaims(). For new Supabase projects using asymmetric
    // keys this verifies locally via the JWKS cache — no Auth server network
    // call per request. The publishable key is used (not the secret key) as
    // this is a low-privilege verification-only client.
    const verifier = createClient(
      this.config.getOrThrow('NEXT_PUBLIC_SUPABASE_URL'),
      this.config.getOrThrow('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
      { auth: { persistSession: false } },
    )

    const { data, error } = await verifier.auth.getClaims(accessToken)

    if (error || !data?.claims?.sub) {
      throw new UnauthorizedException('Invalid or expired token')
    }

    // claims.email exists at runtime but is not in the RequiredClaims type
    const claims = data.claims as any

    request.user = {
      id: claims.sub as string,
      email: claims.email as string,
      accessToken,
    }

    return true
  }
}

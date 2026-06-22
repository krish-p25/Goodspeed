# Phase 2 - Authentication and the BFF Guard

> **For Claude Code:** Work through this in order. Do not add features beyond
> what is described here. Stop at each verification gate and confirm it passes
> before continuing. Report the completion checklist at the end.

---

## Context

Phase 2 wires Supabase Auth across both apps:

- **apps/web** - sign-up, sign-in, sign-out UI using @supabase/ssr and
  @supabase/supabase-js. Cookie-based sessions, Next.js middleware to
  refresh tokens, protected routes that redirect to login.
- **apps/api** - a NestJS AuthGuard that extracts the Bearer JWT from
  incoming requests, verifies it via getClaims() against the project JWKS
  endpoint, extracts the user_id, and creates two request-scoped Supabase
  clients:
  - A user-scoped client (initialised with the user access token) so
    RLS is enforced at the database layer for all data queries.
  - An admin client (initialised with SUPABASE_SECRET_KEY) for operations
    that legitimately need to bypass RLS.
- A protected test endpoint GET /auth/me that returns the verified user ID
  to prove the full auth chain works before any feature code is written.

**Key decisions baked in:**
- getClaims(jwt) used in the guard: verifies locally via JWKS cache, fast,
  no extra network hop per request. sub claim = Supabase user ID.
- getUser() is NOT used in the guard - it makes a network call to the Auth
  server on every request. Reserve it for cases needing a fresh server-
  confirmed user record.
- The user-scoped Supabase client is created per-request using the access
  token, so RLS policies resolve correctly for all DB queries.
- SUPABASE_SECRET_KEY is never exposed to the frontend or logged.
- NestJS reads NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  directly — no duplicate env vars needed. The NEXT_PUBLIC_ prefix is a
  Next.js browser-bundling convention; NestJS ignores it and reads the
  variable by name like any other env var.

---

## Step 1 - Install dependencies

### apps/web

```
npm install @supabase/supabase-js @supabase/ssr --workspace=@kb/web
```

### apps/api

```
npm install @supabase/supabase-js @nestjs/config --workspace=@kb/api
```

**Gate:** npm install completes with no errors for both workspaces.

---

## Step 2 - Environment variables

Confirm the following variables exist in both .env and .env.example and are
filled with real values in .env:

```dotenv
# Supabase — shared name used by both apps.
# NEXT_PUBLIC_ prefix is required for Next.js to expose these to the browser.
# NestJS reads them by this same name — no duplicate vars needed.
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...

# Server-only — NestJS and apps/api only. Never prefix with NEXT_PUBLIC_.
# SUPABASE_SECRET_KEY bypasses RLS — never expose to the client.
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_JWKS_URL=https://your-project.supabase.co/auth/v1/.well-known/jwks.json
```

Remove any duplicate SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY entries that
may exist from Phase 0 — those are now consolidated into the NEXT_PUBLIC_
prefixed versions above.

**Gate:** Four variables present and non-placeholder in .env. No duplicates.

---

## Step 3 - apps/web: Supabase client utilities

Create a lib/supabase/ folder inside apps/web/src (or apps/web if no src
dir) with three files:

### lib/supabase/client.ts

Browser client — used in Client Components:

```typescript
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  )
}
```

### lib/supabase/server.ts

Server client — used in Server Components, Server Actions, Route Handlers:

```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component — cookies cannot be set here.
            // Middleware handles token refresh and cookie updates.
          }
        },
      },
    }
  )
}
```

### lib/supabase/middleware.ts

Token refresh helper — used only by Next.js middleware:

```typescript
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Use getClaims() not getSession() in middleware.
  // getClaims() verifies the JWT locally via JWKS — fast and secure.
  // getSession() reads from storage without revalidation and must not
  // be trusted in server code per Supabase docs.
  const { data } = await supabase.auth.getClaims()
  const user = data?.claims

  const { pathname } = request.nextUrl
  const isAuthRoute =
    pathname.startsWith('/login') || pathname.startsWith('/signup')
  const isProtected =
    !isAuthRoute &&
    pathname !== '/' &&
    !pathname.startsWith('/_next') &&
    !pathname.startsWith('/api')

  if (isProtected && !user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}
```

**Gate:** All three files created with no TypeScript errors.

---

## Step 4 - apps/web: Next.js middleware

Create middleware.ts at the root of apps/web (same level as the app/ dir):

```typescript
import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
```

**Gate:** npm run dev --workspace=@kb/web starts with no errors.

---

## Step 5 - apps/web: Auth pages

Create minimal but functional sign-up, sign-in, and sign-out flows using
Server Actions. Use getClaims() to read the session in Server Components.

### Route structure to create:

```
app/
  (auth)/
    login/
      page.tsx         sign-in form
      actions.ts       Server Action: signIn
    signup/
      page.tsx         sign-up form
      actions.ts       Server Action: signUp
  (protected)/
    dashboard/
      page.tsx         protected page, shows user email and sign-out button
      actions.ts       Server Action: signOut
```

### Sign-in action (app/(auth)/login/actions.ts):

```typescript
'use server'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export async function signIn(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  })
  if (error) redirect('/login?error=' + encodeURIComponent(error.message))
  redirect('/dashboard')
}
```

### Sign-up action (app/(auth)/signup/actions.ts):

```typescript
'use server'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export async function signUp(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  })
  if (error) redirect('/signup?error=' + encodeURIComponent(error.message))
  redirect('/login?message=Check your email to confirm your account')
}
```

### Sign-out action (app/(protected)/dashboard/actions.ts):

```typescript
'use server'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
```

### Protected dashboard page:

```typescript
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { signOut } from './actions'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data?.claims) redirect('/login')

  return (
    <div>
      <p>Signed in as: {data.claims.email as string}</p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  )
}
```

The login and signup page UI should be a minimal functional form with two
inputs (email and password) and a submit button. Display error or message
params from the URL if present. No design work is needed at this stage.

**Gate:**
- Visiting /dashboard while signed out redirects to /login
- Sign-up creates a user (confirm in Supabase dashboard under Authentication
  then Users)
- Sign-in with valid credentials redirects to /dashboard showing the email
- Sign-out redirects to /login

---

## Step 6 - apps/api: Supabase module

Create a NestJS module that provides both Supabase clients as injectable
services. NestJS ConfigService reads NEXT_PUBLIC_ prefixed vars by their
exact name — the prefix has no special meaning outside of Next.js.

### apps/api/src/supabase/supabase.service.ts

```typescript
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

@Injectable()
export class SupabaseService {
  private readonly adminClient: SupabaseClient

  constructor(private config: ConfigService) {
    // Admin client: bypasses RLS. Use only for operations that legitimately
    // need elevated access (e.g. writing embeddings in Phase 5).
    this.adminClient = createClient(
      this.config.getOrThrow('NEXT_PUBLIC_SUPABASE_URL'),
      this.config.getOrThrow('SUPABASE_SECRET_KEY'),
      { auth: { persistSession: false } }
    )
  }

  /**
   * Admin client: bypasses RLS. Keep usage minimal and intentional.
   */
  getAdminClient(): SupabaseClient {
    return this.adminClient
  }

  /**
   * Creates a per-request user-scoped client. Initialised with the user
   * access token so PostgREST runs queries as that user and RLS applies.
   */
  getUserClient(accessToken: string): SupabaseClient {
    return createClient(
      this.config.getOrThrow('NEXT_PUBLIC_SUPABASE_URL'),
      this.config.getOrThrow('SUPABASE_SECRET_KEY'),
      {
        auth: { persistSession: false },
        global: {
          headers: { Authorization: 'Bearer ' + accessToken },
        },
      }
    )
  }
}
```

### apps/api/src/supabase/supabase.module.ts

```typescript
import { Module } from '@nestjs/common'
import { SupabaseService } from './supabase.service'

@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
```

Import SupabaseModule and ConfigModule (with isGlobal: true) in AppModule.
ConfigModule should be configured to load the .env file:

```typescript
ConfigModule.forRoot({ isGlobal: true })
```

**Gate:** npm run build --workspace=@kb/api succeeds with no TypeScript errors.

---

## Step 7 - apps/api: AuthGuard

### apps/api/src/auth/auth.guard.ts

```typescript
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

    // Verify JWT using getClaims(). For new Supabase projects using asymmetric
    // keys this verifies locally via the JWKS cache — no Auth server network
    // call needed. The publishable key is used here (not the secret key) as
    // this is a low-privilege verification-only client.
    const verifier = createClient(
      this.config.getOrThrow('NEXT_PUBLIC_SUPABASE_URL'),
      this.config.getOrThrow('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
      { auth: { persistSession: false } }
    )

    const { data, error } = await verifier.auth.getClaims(accessToken)

    if (error || !data?.claims?.sub) {
      throw new UnauthorizedException('Invalid or expired token')
    }

    // getClaims() returns JwtPayload typed as RequiredClaims & { [key: string]: any }
    // Common fields like email exist at runtime but are not strongly typed.
    // Cast to any to access them without TypeScript complaints.
    const claims = data.claims as any

    // Attach verified identity to request for use in controllers
    request.user = {
      id: claims.sub as string,
      email: claims.email as string,
      accessToken,
    }

    return true
  }
}
```

### apps/api/src/auth/auth.module.ts

```typescript
import { Module } from '@nestjs/common'
import { AuthGuard } from './auth.guard'
import { AuthController } from './auth.controller'

@Module({
  controllers: [AuthController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
```

Import AuthModule in AppModule.

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 8 - apps/api: Protected test endpoint

### apps/api/src/auth/auth.controller.ts

```typescript
import { Controller, Get, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from './auth.guard'

@Controller('auth')
export class AuthController {
  @Get('me')
  @UseGuards(AuthGuard)
  getMe(@Request() req: any) {
    return {
      userId: req.user.id,
      email: req.user.email,
    }
  }
}
```

To get an access token for testing, add this temporarily to a Client
Component on the dashboard page and check the browser console. Remove it
immediately after testing:

```typescript
// Temporary — remove after confirming the gate passes
const supabase = createClient()
const { data } = await supabase.auth.getSession()
console.log(data.session?.access_token)
```

Test the endpoint using a REST client (Bruno, Insomnia, or Postman):

```
GET http://localhost:3010/auth/me
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Gate:**
- Unauthenticated request returns 401 Unauthorized
- Authenticated request with a valid token returns 200 with correct userId
  and email
- Remove the temporary token-logging code after confirming

---

## Step 9 - Optional: disable email confirmation for development

By default Supabase requires email confirmation before sign-in works.
Disable this for development to avoid confirming every test account:

Supabase dashboard -> Authentication -> Providers -> Email -> toggle
Confirm email off.

Re-enable before any production use.

---

## Phase 2 completion checklist

- [ ] @supabase/ssr and @supabase/supabase-js installed in apps/web
- [ ] @supabase/supabase-js and @nestjs/config installed in apps/api
- [ ] .env has exactly four Supabase variables with no duplicates
- [ ] Three Supabase client utility files created in apps/web lib/supabase/
- [ ] Next.js middleware wired with correct route matcher
- [ ] Sign-up creates a user visible in Supabase dashboard
- [ ] Sign-in redirects to /dashboard showing user email
- [ ] /dashboard redirects to /login when signed out
- [ ] Sign-out clears session and redirects to /login
- [ ] SupabaseModule and SupabaseService created in apps/api
- [ ] ConfigModule configured with isGlobal: true in AppModule
- [ ] AuthGuard created and imported into AuthModule
- [ ] AuthModule imported in AppModule
- [ ] GET /auth/me returns 401 without a token
- [ ] GET /auth/me returns 200 with correct userId and email with valid token
- [ ] Temporary token-logging code removed

**Do not begin Phase 3 (Document CRUD) until every box is checked.**

---

## Key design decisions (document in README later)

- **BFF pattern:** all data traffic routes through NestJS. The frontend
  never talks to Supabase directly for data, only for auth session management.
- **Single env var for URL and publishable key:** NEXT_PUBLIC_ prefixed vars
  are used by both apps. Next.js exposes them to the browser via the prefix;
  NestJS reads them by their exact name and ignores the prefix convention.
  SUPABASE_SECRET_KEY remains unprefixed — it must never reach the browser.
- **getClaims() not getUser() in the guard:** getClaims() verifies locally
  against the JWKS cache with no network hop per request. getUser() makes an
  Auth server call on every request and is reserved for fresh user lookups.
- **Per-request user-scoped client:** getUserClient(token) creates a client
  with the user JWT on the Authorization header. PostgREST runs queries as
  that user so RLS enforces per-user data isolation at the database layer.
- **Admin client used sparingly:** getAdminClient() bypasses RLS. Its use
  is intentional and limited to server-to-server operations such as writing
  embeddings in Phase 5.
- **SUPABASE_SECRET_KEY never leaves the API:** not in any NEXT_PUBLIC_
  variable and never returned in any response.

---

## Explicitly out of scope for Phase 2

- Document CRUD endpoints or UI (Phase 3)
- The AI provider abstraction (Phase 4)
- Embedding, chunking, retrieval, or chat logic (Phases 5-9)
- OAuth providers (email/password is sufficient per the brief)
- Password reset flow (not required by the brief)

# Phase 3 - Document CRUD

> **For Claude Code:** Work through this in order. Do not add features beyond
> what is described here — no embedding, chunking, or AI logic belongs in this
> phase. Stop at each verification gate and confirm it passes before continuing.
> Report the completion checklist at the end.

---

## Context

Phase 3 builds the first real feature layer: full document CRUD. By the end,
a signed-in user can create, read, update, and delete their own documents
through a working UI. No other user can see or touch their documents — RLS
enforces this at the database layer automatically because all queries go
through the user-scoped Supabase client from Phase 2.

**Architecture decisions baked in:**
- Document list page: Server Component — fetches from NestJS on the server,
  renders HTML. No client-side fetch library needed.
- Document editor page: Server Component shell + Client Component island.
  The shell fetches initial document data server-side and passes it as props
  to a client-side editor component. This is the idiomatic Next.js App Router
  pattern for pages that mix server data with client interactivity.
- Editor: @uiw/react-md-editor — stores plain markdown text, which flows
  cleanly into the RAG pipeline in Phase 5.
- Save mutation: plain fetch + useState in the Client Component. No TanStack
  Query needed for a single mutation — keep dependencies lean.
- New document creation: POST /documents creates a stub immediately with a
  default title and empty content, then redirects to the editor. Empty stubs
  may appear if the user navigates away before editing — this is acceptable
  and matches the Notion pattern. Note it in the README.
- URL structure: /documents/[id] — edit is the default view for a document.
  No separate /edit route needed.
- Tags: stored as a text[] column (already in schema). Accept as a
  comma-separated string in the UI, split on save.

---

## Step 1 - Install dependencies

### apps/web

```
npm install @uiw/react-md-editor --workspace=@kb/web
```

### apps/api

No new dependencies needed — @supabase/supabase-js is already installed.

**Gate:** npm install completes with no errors.

---

## Step 2 - Install and initialise shadcn/ui

shadcn/ui components are copy-pasted into the repo rather than imported from
node_modules. Run the initialiser from inside apps/web:

```
cd apps\web
npx shadcn@latest init
```

When prompted:
- Style: Default
- Base color: your choice (Slate is a safe neutral)
- CSS variables: Yes

Then add the specific components needed for this phase:

```
npx shadcn@latest add button input label textarea badge card
```

Return to the repo root after:

```
cd ..\..
```

**Gate:** A components/ui/ folder exists inside apps/web/src (or apps/web)
containing the added component files.

---

## Step 3 - Shared TypeScript types

Add document types to packages/types/src/index.ts. These are used by both
apps/web and apps/api:

```typescript
export interface Document {
  id: string
  user_id: string
  title: string
  content: string
  tags: string[]
  created_at: string
  updated_at: string
}

export interface CreateDocumentDto {
  title: string
  content: string
  tags?: string[]
}

export interface UpdateDocumentDto {
  title?: string
  content?: string
  tags?: string[]
}
```

**Gate:** packages/types builds with no errors:
npm run build --workspace=@kb/types

---

## Step 4 - apps/api: Documents module

Create the NestJS documents feature module.

### File structure to create in apps/api/src/documents/:

```
documents/
  documents.module.ts
  documents.controller.ts
  documents.service.ts
  dto/
    create-document.dto.ts
    update-document.dto.ts
```

### dto/create-document.dto.ts

```typescript
export class CreateDocumentDto {
  title: string
  content: string
  tags?: string[]
}
```

### dto/update-document.dto.ts

```typescript
export class UpdateDocumentDto {
  title?: string
  content?: string
  tags?: string[]
}
```

### documents.service.ts

All queries use the user-scoped Supabase client (getUserClient) so RLS
enforces ownership — no manual user_id filtering needed in queries, though
it is good practice to include it explicitly for clarity and defence in depth.

```typescript
import { Injectable, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { CreateDocumentDto } from './dto/create-document.dto'
import { UpdateDocumentDto } from './dto/update-document.dto'

@Injectable()
export class DocumentsService {
  constructor(private supabase: SupabaseService) {}

  async findAll(userId: string, accessToken: string) {
    const client = this.supabase.getUserClient(accessToken)
    const { data, error } = await client
      .from('documents')
      .select('id, title, tags, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })

    if (error) throw new Error(error.message)
    return data
  }

  async findOne(id: string, userId: string, accessToken: string) {
    const client = this.supabase.getUserClient(accessToken)
    const { data, error } = await client
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (error || !data) throw new NotFoundException('Document not found')
    return data
  }

  async create(dto: CreateDocumentDto, userId: string, accessToken: string) {
    const client = this.supabase.getUserClient(accessToken)
    const { data, error } = await client
      .from('documents')
      .insert({
        title: dto.title,
        content: dto.content,
        tags: dto.tags ?? [],
        user_id: userId,
      })
      .select()
      .single()

    if (error || !data) throw new Error(error?.message ?? 'Failed to create document')
    return data
  }

  async update(
    id: string,
    dto: UpdateDocumentDto,
    userId: string,
    accessToken: string,
  ) {
    const client = this.supabase.getUserClient(accessToken)
    const { data, error } = await client
      .from('documents')
      .update({
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.content !== undefined && { content: dto.content }),
        ...(dto.tags !== undefined && { tags: dto.tags }),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error || !data) throw new NotFoundException('Document not found or update failed')
    return data
  }

  async remove(id: string, userId: string, accessToken: string) {
    const client = this.supabase.getUserClient(accessToken)
    const { error } = await client
      .from('documents')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (error) throw new NotFoundException('Document not found or delete failed')
    return { success: true }
  }
}
```

### documents.controller.ts

```typescript
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { DocumentsService } from './documents.service'
import { CreateDocumentDto } from './dto/create-document.dto'
import { UpdateDocumentDto } from './dto/update-document.dto'

@Controller('documents')
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  findAll(@Request() req: any) {
    return this.documentsService.findAll(req.user.id, req.user.accessToken)
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.documentsService.findOne(id, req.user.id, req.user.accessToken)
  }

  @Post()
  create(@Body() dto: CreateDocumentDto, @Request() req: any) {
    return this.documentsService.create(dto, req.user.id, req.user.accessToken)
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @Request() req: any,
  ) {
    return this.documentsService.update(id, dto, req.user.id, req.user.accessToken)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.documentsService.remove(id, req.user.id, req.user.accessToken)
  }
}
```

### documents.module.ts

```typescript
import { Module } from '@nestjs/common'
import { DocumentsController } from './documents.controller'
import { DocumentsService } from './documents.service'
import { SupabaseModule } from '../supabase/supabase.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
```

Import DocumentsModule in AppModule.

**Gate:** npm run build --workspace=@kb/api succeeds with no TypeScript errors.

---

## Step 5 - apps/api: API verification

With both apps running (npm run dev from root), test all five endpoints using
a REST client with a valid Bearer token from the web app session.

```
POST   http://localhost:3010/documents
       Body: { "title": "Test Doc", "content": "Hello world", "tags": ["test"] }
       → 201 with full document object including id

GET    http://localhost:3010/documents
       → 200 with array of documents (content field omitted — list query
         only selects id, title, tags, created_at, updated_at for efficiency)

GET    http://localhost:3010/documents/:id
       → 200 with full document including content

PATCH  http://localhost:3010/documents/:id
       Body: { "title": "Updated Title" }
       → 200 with updated document

DELETE http://localhost:3010/documents/:id
       → 200 with { "success": true }
```

Cross-user isolation test: attempt to GET, PATCH, or DELETE a document
belonging to another user (if you have a second test account). Should return
404 — RLS means the row is simply invisible to the other user.

**Gate:** All five endpoints respond correctly. Cross-user request returns 404.

---

## Step 6 - apps/web: API client utility

Create a thin server-side API client that the Next.js Server Components use
to call the NestJS API with the user's access token.

### apps/web/src/lib/api.ts

```typescript
import { createClient } from '@/lib/supabase/server'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getAccessToken(): Promise<string> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not authenticated')
  return token
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken()
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API error ${res.status}: ${body}`)
  }
  return res.json()
}

export const documentsApi = {
  list: () =>
    apiFetch<Document[]>('/documents'),

  get: (id: string) =>
    apiFetch<Document>(`/documents/${id}`),

  create: (body: { title: string; content: string; tags?: string[] }) =>
    apiFetch<Document>('/documents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  update: (id: string, body: { title?: string; content?: string; tags?: string[] }) =>
    apiFetch<Document>(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  delete: (id: string) =>
    apiFetch<{ success: boolean }>(`/documents/${id}`, {
      method: 'DELETE',
    }),
}
```

Import the Document type from @kb/types in this file rather than using the
built-in DOM Document type — rename the import to avoid the collision:

```typescript
import type { Document as KBDocument } from '@kb/types'
```

And update the apiFetch return types and documentsApi methods accordingly.

**Gate:** File created with no TypeScript errors.

---

## Step 7 - apps/web: Document list page

### Route structure to create:

```
app/
  (protected)/
    dashboard/
      page.tsx       (already exists from Phase 2 — update this)
    documents/
      page.tsx       document list
      actions.ts     Server Actions: createDocument, deleteDocument
      [id]/
        page.tsx     Server Component shell
        editor.tsx   Client Component — the actual editor
```

### app/(protected)/documents/actions.ts

Server Actions for mutations — these run on the server, call the NestJS API,
then revalidate the relevant Next.js cache path so the UI updates without a
full page reload.

```typescript
'use server'
import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getToken() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token
}

export async function createDocument() {
  const token = await getToken()
  const res = await fetch(`${API_URL}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title: 'Untitled Document', content: '' }),
  })
  const doc = await res.json()
  revalidatePath('/documents')
  redirect(`/documents/${doc.id}`)
}

export async function deleteDocument(id: string) {
  const token = await getToken()
  await fetch(`${API_URL}/documents/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  revalidatePath('/documents')
}
```

### app/(protected)/documents/page.tsx

Server Component — fetches the document list on the server:

```typescript
import { documentsApi } from '@/lib/api'
import { createDocument, deleteDocument } from './actions'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import Link from 'next/link'
import type { Document as KBDocument } from '@kb/types'

export default async function DocumentsPage() {
  let documents: KBDocument[] = []
  try {
    documents = await documentsApi.list()
  } catch {
    documents = []
  }

  return (
    <div>
      <div>
        <h1>Documents</h1>
        <form action={createDocument}>
          <Button type="submit">New Document</Button>
        </form>
      </div>

      {documents.length === 0 ? (
        <p>No documents yet. Create one to get started.</p>
      ) : (
        <div>
          {documents.map((doc) => (
            <Card key={doc.id}>
              <Link href={`/documents/${doc.id}`}>
                <h2>{doc.title}</h2>
                <p>{new Date(doc.updated_at).toLocaleDateString()}</p>
                <div>
                  {doc.tags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
              </Link>
              <form action={deleteDocument.bind(null, doc.id)}>
                <Button type="submit" variant="destructive">Delete</Button>
              </form>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
```

---

## Step 8 - apps/web: Document editor

### app/(protected)/documents/[id]/page.tsx

Server Component shell — fetches the document server-side then hands it
to the client editor:

```typescript
import { documentsApi } from '@/lib/api'
import { notFound } from 'next/navigation'
import { DocumentEditor } from './editor'

export default async function DocumentPage({
  params,
}: {
  params: { id: string }
}) {
  let document
  try {
    document = await documentsApi.get(params.id)
  } catch {
    notFound()
  }

  return <DocumentEditor document={document} />
}
```

### app/(protected)/documents/[id]/editor.tsx

Client Component — the interactive editor. Saves by calling the NestJS API
directly from the browser with the user's session token:

```typescript
'use client'
import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import type { Document as KBDocument } from '@kb/types'

// Dynamic import required — react-md-editor uses browser APIs and cannot
// be server-side rendered
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false })

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getToken(): Promise<string> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

export function DocumentEditor({ document }: { document: KBDocument }) {
  const router = useRouter()
  const [title, setTitle] = useState(document.title)
  const [content, setContent] = useState(document.content)
  const [tags, setTags] = useState(document.tags.join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/documents/${document.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title,
          content,
          // Split on comma, trim whitespace, drop empty strings
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      setSaved(true)
      router.refresh()  // revalidates the Server Component above
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }, [title, content, tags, document.id, router])

  return (
    <div>
      <div>
        <Button variant="outline" onClick={() => router.push('/documents')}>
          Back
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
        {saved && <span>Saved</span>}
        {error && <span>{error}</span>}
      </div>

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Document title"
      />

      <Input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="Tags (comma separated)"
      />

      <MDEditor
        value={content}
        onChange={(val) => setContent(val ?? '')}
        height={500}
      />
    </div>
  )
}
```

**Gate:**
- /documents lists all documents for the signed-in user
- Clicking New Document creates a stub and redirects to the editor
- The editor loads with the document's current title, content, and tags
- Editing and clicking Save persists changes (verify in Supabase dashboard
  or by refreshing the page)
- Tags entered as comma-separated strings are saved as an array
- Clicking Back returns to the document list
- Deleting a document from the list removes it and refreshes the list
- Visiting /documents/[non-existent-id] shows a 404 page
- Signing in as a different user cannot see or access the first user's
  documents (404 on direct URL, not in list)

---

## Step 9 - Update dashboard

Update the existing /dashboard page from Phase 2 to link to the documents
section now that it exists:

```typescript
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { signOut } from './actions'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  if (!data?.claims) redirect('/login')

  return (
    <div>
      <p>Signed in as: {data.claims.email as string}</p>
      <Link href="/documents">
        <Button>My Documents</Button>
      </Link>
      <form action={signOut}>
        <Button type="submit" variant="outline">Sign out</Button>
      </form>
    </div>
  )
}
```

---

## Phase 3 completion checklist

- [ ] @uiw/react-md-editor installed in apps/web
- [ ] shadcn/ui initialised with button, input, label, textarea, badge, card
- [ ] Document types added to packages/types
- [ ] DocumentsModule created in apps/api with all five endpoints
- [ ] DocumentsModule imported in AppModule
- [ ] All five API endpoints respond correctly with valid auth token
- [ ] Cross-user request returns 404 (RLS isolation confirmed)
- [ ] documentsApi utility created in apps/web/src/lib/api.ts
- [ ] Document list page renders at /documents
- [ ] New Document button creates a stub and redirects to the editor
- [ ] Editor loads with existing document data
- [ ] Save persists title, content, and tags correctly
- [ ] Tags stored as array (confirm in Supabase dashboard)
- [ ] Delete removes document and refreshes list
- [ ] /documents/[non-existent-id] returns 404
- [ ] Dashboard updated with link to /documents

**Do not begin Phase 4 (AI provider abstraction) until every box is checked.**

---

## Key design decisions (document in README later)

- **Server Component list + Client Component editor:** idiomatic App Router
  pattern. The list benefits from server rendering (fast, no loading state).
  The editor needs client interactivity for the markdown editor so uses the
  server shell + client island pattern.
- **Stub-on-create:** documents are created immediately when New Document is
  clicked, before any content is entered. This matches the Notion pattern and
  avoids a multi-step creation flow. Empty stubs may appear if the user
  navigates away — noted as a known limitation.
- **Plain markdown content:** @uiw/react-md-editor stores plain markdown text.
  This feeds cleanly into the chunking and embedding pipeline in Phase 5
  without any HTML or JSON parsing.
- **revalidatePath after mutations:** Server Actions call revalidatePath so
  the document list stays fresh after create/delete without a full page
  reload. The editor calls router.refresh() after save for the same reason.
- **Defence in depth on user_id:** queries include .eq('user_id', userId)
  even though RLS already enforces this. Belt and braces — a misconfigured
  RLS policy would not silently leak data.

---

## Explicitly out of scope for Phase 3

- Embedding or chunking documents (Phase 5)
- The AI provider abstraction (Phase 4)
- Search or filtering of the document list
- Pagination (not needed at assessment scale)
- Autosave (would require debouncing — save button is sufficient)
- Rich text beyond markdown

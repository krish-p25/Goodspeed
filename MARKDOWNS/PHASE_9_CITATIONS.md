# Phase 9 — Span-Level Citations

> **For Claude Code:** This is the final feature phase. Work through it in
> order. Phase 9 is purely additive — nothing from Phases 7 or 8 changes
> structurally. The citation instruction is added to the system prompt, a
> buffering stream resolver intercepts citation markers mid-stream, a new
> SSE event type carries resolved sentences, and the frontend renders
> highlighted spans with hover tooltips. Stop at each verification gate
> and confirm it passes before continuing. Report the completion checklist
> at the end.

---

## Context

Phase 9 adds span-level citations: as the model streams its answer, citation
markers like [c0_s1] are intercepted by a buffering resolver, validated
against the sentence map built at retrieval time, and emitted as citation
SSE events. The frontend renders highlighted spans inline in the answer text
with hover tooltips showing the exact source sentence.

**What is already in place from earlier phases:**
- Sentence maps built at retrieval time with stable c{pos}_s{idx} IDs (Phase 6)
- Chunks formatted with (c0_s0) sentence ID labels in the system prompt (Phase 7)
- CitationEvent and StreamEvent types in packages/types (Phase 4)
- message_sources table with sentence_text, char_start, char_end columns (Phase 1)
- Document-level citations as the guaranteed floor (Phase 7)

**What Phase 9 adds:**
- Citation instruction appended to the grounding system prompt
- CitationStreamEvent SSE type for the frontend
- Buffering stream resolver in ChatService.runStream()
- Span-level message_sources rows persisted after stream
- Frontend segment renderer with highlighted spans and hover tooltips

**Fallback guarantee:** Document-level citations from Phase 7 remain the
floor. If the model emits no valid citation markers, or all markers are
invalid, the sources block still shows the correct document names. Span-
level citations are an enhancement — the feature never breaks, it only
degrades gracefully.

---

## Step 1 — Add citation SSE event type to packages/types

The CitationEvent and StreamEvent types already exist in packages/types
from Phase 4. Add a new SSE-specific citation event type alongside the
existing streaming types:

Add to packages/types/src/index.ts:

```typescript
// Citation event emitted by the SSE stream when a valid citation marker
// is resolved. Carries the resolved sentence data for frontend rendering.
export interface CitationStreamEvent {
  type: 'citation'
  ids: string[]           // the validated sentence IDs e.g. ["c0_s1", "c1_s0"]
  sentences: Array<{
    id: string
    documentTitle: string
    text: string            // the exact cited sentence
    charStart: number
    charEnd: number
  }>
  // Position in the answer text where the citation marker appeared.
  // Used by the frontend to replace the marker with a highlighted span.
  markerText: string        // the original marker text e.g. "[c0_s1]"
}

// Update ChatSseEvent union to include the new type:
// (replace the existing ChatSseEvent export)
export type ChatSseEvent =
  | TokenEvent
  | CitationStreamEvent
  | SourcesEvent
  | DoneEvent
  | ErrorEvent
```

**Gate:** npm run build --workspace=@kb/types succeeds.

---

## Step 2 — Add citation instruction to PromptBuilderService

Update the grounding instruction in apps/api/src/chat/prompt-builder.service.ts
to include the citation instruction. Only the private buildGroundingInstruction()
method changes — no other method is affected.

```typescript
private buildGroundingInstruction(): string {
  return [
    'You are a knowledge base assistant. Answer the user\'s question using only the context provided below, which has been retrieved from the user\'s own documents.',
    '',
    '- Base your answer solely on the provided context.',
    '- If the context does not contain enough information to answer, say so plainly rather than guessing or drawing on outside knowledge.',
    '- Be concise and direct.',
    '- When you use information from a specific sentence, cite it by appending its ID in square brackets immediately after the claim, e.g. [c0_s1].',
    '- Only cite sentence IDs that appear exactly in the context below. Do not invent IDs.',
    '- A claim may cite multiple sentences: [c0_s1][c1_s0].',
    '- If no sentence directly supports a claim, do not cite.',
  ].join('\n')
}
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 3 — Citation stream resolver

Create the buffering resolver as a standalone utility. Keeping it separate
from ChatService makes it independently testable.

### apps/api/src/chat/citation-resolver.ts

```typescript
import type { RetrievedChunk, CitableSentence } from '@kb/types'

export interface ResolvedCitation {
  ids: string[]
  sentences: CitableSentence[]
  markerText: string
}

export interface StreamSegment {
  type: 'text' | 'citation'
  // type === 'text': the safe text to emit
  text?: string
  // type === 'citation': the resolved citation
  citation?: ResolvedCitation
}

/**
 * CitationStreamResolver
 *
 * Processes a stream of token deltas and intercepts citation markers
 * like [c0_s1] that may arrive split across token boundaries.
 *
 * The resolver maintains a buffer of text that might still become a
 * citation marker. On each token:
 *   1. Append delta to buffer
 *   2. Resolve any complete markers found
 *   3. Emit all text up to any trailing partial marker as safe text
 *   4. Hold the partial in the buffer until the next token arrives
 *
 * Valid markers are validated against the sentence map. Invalid IDs
 * (hallucinated by the model) are silently dropped — the surrounding
 * text is emitted as-is without the marker.
 *
 * Call flush() after the stream ends to emit any remaining buffer content.
 */
export class CitationStreamResolver {
  private buffer = ''
  // Matches complete markers: [c0_s1] or [c0_s1][c1_s0] (chained)
  private readonly COMPLETE_MARKER =
    /\[(c\d+_s\d+(?:\]\[c\d+_s\d+)*)\]/g
  // Matches a trailing partial that could still become a marker
  private readonly PARTIAL_MARKER = /\[c?\d*_?s?\d*\]?$/

  constructor(private readonly sentenceMap: Map<string, CitableSentence>) {}

  /**
   * Process a new token delta and return any segments safe to emit.
   */
  process(delta: string): StreamSegment[] {
    this.buffer += delta
    return this.resolveBuffer(false)
  }

  /**
   * Flush remaining buffer content after the stream ends.
   * Any unresolved partial markers become plain text.
   */
  flush(): StreamSegment[] {
    return this.resolveBuffer(true)
  }

  private resolveBuffer(flushing: boolean): StreamSegment[] {
    const segments: StreamSegment[] = []
    let lastEmitted = 0

    this.COMPLETE_MARKER.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = this.COMPLETE_MARKER.exec(this.buffer)) !== null) {
      // Emit text before this marker
      const textBefore = this.buffer.slice(lastEmitted, match.index)
      if (textBefore) {
        segments.push({ type: 'text', text: textBefore })
      }

      // Validate and resolve the marker
      const ids = match[1].split('][')
      const validIds = ids.filter((id) => this.sentenceMap.has(id))

      if (validIds.length > 0) {
        const sentences = validIds.map((id) => this.sentenceMap.get(id)!)
        segments.push({
          type: 'citation',
          citation: {
            ids: validIds,
            sentences,
            markerText: match[0],
          },
        })
      }
      // Invalid IDs: silently drop the marker, text before already emitted

      lastEmitted = match.index + match[0].length
    }

    // Determine how much remaining text is safe to emit
    const remaining = this.buffer.slice(lastEmitted)

    if (flushing) {
      // Emit everything — stream is over, no more tokens coming
      if (remaining) segments.push({ type: 'text', text: remaining })
      this.buffer = ''
    } else {
      // Hold back any trailing partial that could still become a marker
      const partialMatch = remaining.match(this.PARTIAL_MARKER)
      if (partialMatch && partialMatch.index !== undefined) {
        const safeText = remaining.slice(0, partialMatch.index)
        if (safeText) segments.push({ type: 'text', text: safeText })
        this.buffer = remaining.slice(partialMatch.index)
      } else {
        if (remaining) segments.push({ type: 'text', text: remaining })
        this.buffer = ''
      }
    }

    return segments
  }
}
```

---

## Step 4 — Update runStream() in ChatService

Replace the token streaming section of runStream() to use the
CitationStreamResolver. Only the token loop changes — everything else
(retrieval, conversation management, persistence) is unchanged.

In apps/api/src/chat/chat.service.ts, add the import:

```typescript
import { CitationStreamResolver } from './citation-resolver'
import type { CitationStreamEvent } from '@kb/types'
```

Replace the token streaming loop in runStream():

```typescript
// Step 5: Stream tokens with citation resolution
let fullAnswer = ''
const resolver = new CitationStreamResolver(
  // Merge all sentence maps from retrieved chunks into one flat map
  new Map(chunks.flatMap((c) => Array.from(c.sentences.entries())))
)
const resolvedCitations: Array<{
  ids: string[]
  sentences: Array<{ id: string; documentTitle: string; text: string; charStart: number; charEnd: number }>
  markerText: string
}> = []

for await (const chunk of this.llm.chatStream(messages)) {
  if (chunk.delta) {
    const segments = resolver.process(chunk.delta)

    for (const segment of segments) {
      if (segment.type === 'text' && segment.text) {
        fullAnswer += segment.text
        const tokenEvent: ChatSseEvent = {
          type: 'token',
          delta: segment.text,
        }
        subject.next({ data: JSON.stringify(tokenEvent) })
      } else if (segment.type === 'citation' && segment.citation) {
        const { ids, sentences, markerText } = segment.citation
        const citationEvent: ChatSseEvent = {
          type: 'citation',
          ids,
          sentences: sentences.map((s) => ({
            id: s.id,
            documentTitle: s.documentTitle,
            text: s.text,
            charStart: s.charStart,
            charEnd: s.charEnd,
          })),
          markerText,
        } as CitationStreamEvent
        subject.next({ data: JSON.stringify(citationEvent) })
        resolvedCitations.push({ ids, sentences: citationEvent.sentences, markerText })
      }
    }
  }
  if (chunk.done) break
}

// Flush remaining buffer after stream ends
const finalSegments = resolver.flush()
for (const segment of finalSegments) {
  if (segment.type === 'text' && segment.text) {
    fullAnswer += segment.text
    const tokenEvent: ChatSseEvent = { type: 'token', delta: segment.text }
    subject.next({ data: JSON.stringify(tokenEvent) })
  } else if (segment.type === 'citation' && segment.citation) {
    const { ids, sentences, markerText } = segment.citation
    const citationEvent: ChatSseEvent = {
      type: 'citation',
      ids,
      sentences: sentences.map((s) => ({
        id: s.id,
        documentTitle: s.documentTitle,
        text: s.text,
        charStart: s.charStart,
        charEnd: s.charEnd,
      })),
      markerText,
    } as CitationStreamEvent
    subject.next({ data: JSON.stringify(citationEvent) })
    resolvedCitations.push({ ids, sentences: citationEvent.sentences, markerText })
  }
}
```

---

## Step 5 — Persist span-level citations

Update ConversationService.persistMessages() to accept and persist span-
level citations alongside the document-level floor.

Add resolvedCitations as an optional parameter to persistMessages():

```typescript
async persistMessages(params: {
  conversationId: string
  userId: string
  question: string
  answer: string
  sources: Array<{ documentId: string; documentTitle: string }>
  retrievedChunks: RetrievedChunk[]
  resolvedCitations?: Array<{
    ids: string[]
    sentences: Array<{
      id: string
      documentTitle: string
      text: string
      charStart: number
      charEnd: number
    }>
    markerText: string
  }>
}): Promise<string>
```

In the message_sources insert section, when resolvedCitations is provided
and non-empty, insert sentence-level rows instead of (or in addition to)
the document-level rows:

```typescript
// If span-level citations resolved, persist them with sentence text and offsets
if (params.resolvedCitations && params.resolvedCitations.length > 0) {
  const sentenceRows = params.resolvedCitations.flatMap(
    (citation, citationIndex) =>
      citation.sentences.map((sentence, sentenceIndex) => ({
        message_id: assistantMsg.id,
        chunk_id: params.retrievedChunks.find((c) =>
          Array.from(c.sentences.keys()).includes(sentence.id)
        )?.id ?? null,
        document_id: params.retrievedChunks.find((c) =>
          Array.from(c.sentences.keys()).includes(sentence.id)
        )?.documentId ?? null,
        sentence_text: sentence.text,
        char_start: sentence.charStart,
        char_end: sentence.charEnd,
        position: citationIndex * 10 + sentenceIndex,
      }))
  )
  if (sentenceRows.length > 0) {
    await admin.from('message_sources').insert(sentenceRows)
  }
} else if (params.sources.length > 0) {
  // Fall back to document-level citations (the guaranteed floor)
  // ... existing document-level insert code unchanged
}
```

Pass resolvedCitations to persistMessages() in runStream():

```typescript
const messageId = await this.conversation.persistMessages({
  conversationId: convId,
  userId,
  question,
  answer: fullAnswer,
  sources,
  retrievedChunks: chunks,
  resolvedCitations: resolvedCitations.length > 0 ? resolvedCitations : undefined,
})
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 6 — Unit tests for CitationStreamResolver

### apps/api/src/chat/citation-resolver.spec.ts

```typescript
import { CitationStreamResolver } from './citation-resolver'
import type { CitableSentence } from '@kb/types'

const makeSentence = (id: string): CitableSentence => ({
  id,
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  documentTitle: 'Test Doc',
  text: `Sentence ${id}`,
  charStart: 0,
  charEnd: 20,
})

const sentenceMap = new Map([
  ['c0_s0', makeSentence('c0_s0')],
  ['c0_s1', makeSentence('c0_s1')],
  ['c1_s0', makeSentence('c1_s0')],
])

describe('CitationStreamResolver', () => {
  it('emits plain text when no markers present', () => {
    const resolver = new CitationStreamResolver(sentenceMap)
    const segments = [
      ...resolver.process('Hello '),
      ...resolver.process('world'),
      ...resolver.flush(),
    ]
    const text = segments.map((s) => s.text ?? '').join('')
    expect(text).toBe('Hello world')
    expect(segments.every((s) => s.type === 'text')).toBe(true)
  })

  it('resolves a complete marker in one token', () => {
    const resolver = new CitationStreamResolver(sentenceMap)
    const segments = [
      ...resolver.process('RAG is useful [c0_s0] for retrieval.'),
      ...resolver.flush(),
    ]
    const citation = segments.find((s) => s.type === 'citation')
    expect(citation).toBeDefined()
    expect(citation!.citation!.ids).toEqual(['c0_s0'])
  })

  it('resolves a marker split across token boundaries', () => {
    const resolver = new CitationStreamResolver(sentenceMap)
    const segments = [
      ...resolver.process('This is true [c0_'),
      ...resolver.process('s1] indeed.'),
      ...resolver.flush(),
    ]
    const citation = segments.find((s) => s.type === 'citation')
    expect(citation).toBeDefined()
    expect(citation!.citation!.ids).toEqual(['c0_s1'])
  })

  it('drops invalid (hallucinated) marker IDs silently', () => {
    const resolver = new CitationStreamResolver(sentenceMap)
    const segments = [
      ...resolver.process('Something [c9_s9] happened.'),
      ...resolver.flush(),
    ]
    expect(segments.every((s) => s.type === 'text')).toBe(true)
    const text = segments.map((s) => s.text ?? '').join('')
    expect(text).toContain('Something')
    expect(text).toContain('happened.')
    expect(text).not.toContain('[c9_s9]')
  })

  it('handles chained markers [c0_s0][c1_s0]', () => {
    const resolver = new CitationStreamResolver(sentenceMap)
    const segments = [
      ...resolver.process('Two sources [c0_s0][c1_s0] confirm this.'),
      ...resolver.flush(),
    ]
    const citation = segments.find((s) => s.type === 'citation')
    expect(citation).toBeDefined()
    expect(citation!.citation!.ids).toHaveLength(2)
  })

  it('flushes remaining buffer as text after stream ends', () => {
    const resolver = new CitationStreamResolver(sentenceMap)
    resolver.process('Trailing text with no marker')
    const segments = resolver.flush()
    const text = segments.map((s) => s.text ?? '').join('')
    expect(text).toContain('Trailing text with no marker')
  })
})
```

Run:
```
npm run test --workspace=@kb/api
```

**Gate:** All six resolver tests pass.

---

## Step 7 — Frontend: segment renderer

The ChatWindow can no longer render the assistant answer as a plain string
once citations are mixed in. Replace the content string with a segments
array that interleaves text and citation spans.

### Segment types for the frontend

```typescript
interface TextSegment {
  type: 'text'
  text: string
}

interface CitationSegment {
  type: 'citation'
  ids: string[]
  sentences: Array<{
    id: string
    documentTitle: string
    text: string
  }>
  markerText: string
}

type AnswerSegment = TextSegment | CitationSegment
```

### Update ChatMessage state shape

Replace `content: string` with `segments: AnswerSegment[]` and `streaming: boolean`:

```typescript
interface ChatMessage {
  role: 'user' | 'assistant'
  segments: AnswerSegment[]
  sources?: DocumentSource[]
  noContext?: boolean
  streaming?: boolean
}
```

### Update the SSE event handler

Add handling for the new `citation` event type in the fetch stream reader:

```typescript
if (event.type === 'token') {
  setMessages((prev) => {
    const updated = [...prev]
    const last = updated[updated.length - 1]
    if (last?.role === 'assistant') {
      const lastSeg = last.segments[last.segments.length - 1]
      if (lastSeg?.type === 'text') {
        // Append to existing text segment
        updated[updated.length - 1] = {
          ...last,
          segments: [
            ...last.segments.slice(0, -1),
            { type: 'text', text: lastSeg.text + event.delta },
          ],
        }
      } else {
        // Start a new text segment
        updated[updated.length - 1] = {
          ...last,
          segments: [...last.segments, { type: 'text', text: event.delta }],
        }
      }
    }
    return updated
  })
} else if (event.type === 'citation') {
  setMessages((prev) => {
    const updated = [...prev]
    const last = updated[updated.length - 1]
    if (last?.role === 'assistant') {
      updated[updated.length - 1] = {
        ...last,
        segments: [
          ...last.segments,
          {
            type: 'citation',
            ids: event.ids,
            sentences: event.sentences,
            markerText: event.markerText,
          },
        ],
      }
    }
    return updated
  })
}
```

### Segment renderer component

```typescript
function AnswerRenderer({ segments }: { segments: AnswerSegment[] }) {
  return (
    <span>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <span key={i}>{seg.text}</span>
        }
        // Citation segment: highlighted span with hover tooltip
        return (
          <span key={i} className="relative group">
            <mark className="bg-yellow-100 text-yellow-900 rounded px-0.5 cursor-help">
              {/* Render the surrounding text without the marker brackets */}
              {/* The marker is replaced by the highlight itself */}
            </mark>
            {/* Hover tooltip */}
            <span className="absolute bottom-full left-0 z-10 hidden group-hover:block w-72 p-2 bg-white border border-gray-200 rounded shadow-lg text-sm">
              {seg.sentences.map((s) => (
                <span key={s.id} className="block">
                  <span className="font-medium text-gray-500 text-xs">
                    {s.documentTitle}
                  </span>
                  <span className="block text-gray-800 mt-0.5">
                    "{s.text}"
                  </span>
                </span>
              ))}
            </span>
          </span>
        )
      })}
    </span>
  )
}
```

Update the message rendering in ChatWindow to use AnswerRenderer for
assistant messages:

```typescript
{msg.role === 'assistant' ? (
  <AnswerRenderer segments={msg.segments} />
) : (
  <p>{msg.segments.map(s => s.type === 'text' ? s.text : '').join('')}</p>
)}
```

For user messages, the segments array will always contain a single text
segment — extracting the text directly is fine.

**Gate:**
- Asking a relevant question causes the answer to stream token by token
- When the model emits a citation marker, a yellow highlighted span appears
  inline at that position in the answer
- Hovering the highlighted span shows a tooltip with the source document
  title and exact cited sentence
- Hallucinated/invalid markers do not appear — they are silently dropped
- When no citations are emitted, the answer renders as plain text with no
  highlighted spans (document-level sources still shown in the sources block)
- All Phase 8 streaming behaviour is preserved (cursor indicator, sources
  block, URL sync on new conversation)

---

## Step 8 — Integration tests

### Test 1 — Citation markers resolved live

Ask a question that your documents clearly answer. Watch the stream:
- Text tokens appear progressively as before
- At the point where the model cites a sentence, the plain marker text
  ([c0_s1]) should NOT appear — it should be intercepted and replaced by
  a highlighted span
- Hover the highlighted span — tooltip shows the document title and exact
  sentence text

### Test 2 — Fallback to document-level when no markers emitted

Ask a question where the model answers correctly but emits no citation
markers (this happens with shorter answers or when the model doesn't follow
the instruction precisely). Confirm:
- Answer renders as plain text
- Document-level sources block still appears below the answer

### Test 3 — Hallucinated ID dropped

This is hard to force deliberately. If you observe a marker like [c9_s9]
appearing as plain text in the UI, the validation is not working. If the
span appears highlighted instead, a valid sentence matched — that is correct.
The test is passing if no raw bracket markers appear in the UI output.

### Test 4 — Span-level persistence

After a conversation with resolved citations, check the Supabase dashboard:
- message_sources table should have rows with non-empty sentence_text
- char_start and char_end should be populated (not null)
- These rows correspond to the highlighted spans shown in the UI

**Gate:** All four tests pass. Highlighted spans visible with correct hover
content. Sentence-level rows in message_sources.

---

## Phase 9 completion checklist

- [ ] CitationStreamEvent type added to packages/types
- [ ] ChatSseEvent union updated to include CitationStreamEvent
- [ ] Citation instruction added to PromptBuilderService
- [ ] CitationStreamResolver created as standalone utility
- [ ] All six unit tests pass
- [ ] runStream() updated to use CitationStreamResolver
- [ ] Citation events emitted to SSE stream with resolved sentence data
- [ ] persistMessages() accepts and stores span-level citations
- [ ] Span-level message_sources rows persisted with sentence_text and offsets
- [ ] Document-level fallback intact when no citations resolve
- [ ] Frontend segments array replaces plain content string
- [ ] AnswerRenderer component renders text and citation segments
- [ ] Highlighted spans appear inline at citation positions
- [ ] Hover tooltip shows document title and exact cited sentence
- [ ] Invalid markers silently dropped — no raw brackets in UI output
- [ ] Phase 8 streaming behaviour fully preserved
- [ ] Build passes cleanly

---

## Key design decisions (document in README later)

- **Buffering resolver for split markers:** Citation markers arrive split
  across token boundaries. The resolver holds a partial buffer and only
  emits text that cannot be the start of a marker. This prevents raw marker
  text appearing in the UI and handles the most common failure mode.
- **Validation as the trust layer:** Every marker ID is validated against
  the sentence map built at retrieval time. IDs not in the map are silently
  dropped. This means hallucinated citations never reach the user — the
  guaranteed floor (document-level sources) remains the worst case.
- **Highlighted spans not superscripts:** Inline highlighted spans are more
  readable than numbered footnotes for a knowledge base UI. The marker is
  replaced by the highlight itself — no separate footnote list to maintain.
- **Segments array not string:** Once citation spans are mixed into the
  answer, a plain string cannot represent the structure. The segments array
  cleanly separates text and citation spans and maps naturally to React
  component rendering.
- **Document-level floor always shown:** Even when span-level citations
  resolve perfectly, the sources block below the answer still shows document
  names. This gives two levels of attribution — specific (hover tooltip) and
  summary (sources block) — and the summary never breaks.
- **Persistence reflects what was actually cited:** Span-level message_sources
  rows store the exact sentence text resolved at answer time, not a pointer
  that could become stale if the document is later edited.

---

## Explicitly out of scope for Phase 9

- Click-through to document with highlighted span (would require passing
  char offsets to the document editor and implementing a scroll-to-highlight
  feature — noted as future work)
- Query rewriting for follow-up questions (future work)
- Token usage tracking view (stretch goal — data already captured in
  ChatResult.usage)
- File upload with text extraction (stretch goal)

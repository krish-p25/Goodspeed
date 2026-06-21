import type { CitableSentence } from '@kb/types'

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

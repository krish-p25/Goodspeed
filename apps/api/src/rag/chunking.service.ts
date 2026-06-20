import { Injectable } from '@nestjs/common'
import { AiConfigService } from '../ai/ai-config.service'

export interface TextChunk {
  content: string
  index: number
  tokenCount: number
}

@Injectable()
export class ChunkingService {
  constructor(private readonly aiConfig: AiConfigService) {}

  /**
   * Split document content into overlapping chunks.
   * Strategy: split on double newlines (paragraphs) first, then on single
   * newlines, then on sentences. Merge small segments until the target
   * token size is reached, then carry overlap into the next chunk.
   *
   * Token count is approximated as word count * 1.3 — accurate enough for
   * chunking decisions without a tokeniser dependency.
   *
   * targetTokens and overlapFraction are read from ai.config.json on every
   * call — change and save the file to take effect on the next document.
   */
  chunk(content: string): TextChunk[] {
    if (!content.trim()) return []

    const { targetTokens, overlapFraction } = this.aiConfig.getChunkingConfig()
    const segments = this.splitIntoSegments(content, targetTokens)
    const chunks: TextChunk[] = []
    let current: string[] = []
    let currentTokens = 0
    const overlapTokens = Math.floor(targetTokens * overlapFraction)

    for (const segment of segments) {
      const segmentTokens = this.estimateTokens(segment)

      if (currentTokens + segmentTokens > targetTokens && current.length > 0) {
        const chunkContent = current.join(' ').trim()
        if (chunkContent) {
          chunks.push({ content: chunkContent, index: chunks.length, tokenCount: currentTokens })
        }

        // Carry overlap: keep trailing segments up to overlapTokens
        const overlap: string[] = []
        let overlapCount = 0
        for (let i = current.length - 1; i >= 0; i--) {
          const t = this.estimateTokens(current[i])
          if (overlapCount + t > overlapTokens) break
          overlap.unshift(current[i])
          overlapCount += t
        }
        current = overlap
        currentTokens = overlapCount
      }

      current.push(segment)
      currentTokens += segmentTokens
    }

    // Flush the final chunk
    if (current.length > 0) {
      const chunkContent = current.join(' ').trim()
      if (chunkContent) {
        chunks.push({ content: chunkContent, index: chunks.length, tokenCount: currentTokens })
      }
    }

    return chunks
  }

  /**
   * Split content into segments by trying structural boundaries in order:
   * double newlines (paragraphs), single newlines, sentence endings.
   */
  private splitIntoSegments(content: string, targetTokens: number): string[] {
    return content
      .split(/\n\n+/)
      .flatMap((para) => {
        if (this.estimateTokens(para) <= targetTokens) return [para]
        return para.split(/\n/).flatMap((line) => {
          if (this.estimateTokens(line) <= targetTokens) return [line]
          return line.split(/(?<=[.!?])\s+/)
        })
      })
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  /** Approximate token count: word count * 1.3. */
  private estimateTokens(text: string): number {
    return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3)
  }
}

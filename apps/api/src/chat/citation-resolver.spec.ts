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

  it('flushes a held partial marker as text after stream ends', () => {
    // A trailing '[' could be the start of a marker, so the resolver holds it
    // in the buffer during process(). flush() must emit it once the stream ends.
    const resolver = new CitationStreamResolver(sentenceMap)
    const duringStream = resolver.process('Trailing text with a dangling [')
    const onFlush = resolver.flush()

    const flushedText = onFlush.map((s) => s.text ?? '').join('')
    expect(flushedText).toContain('[')

    const allText = [...duringStream, ...onFlush]
      .map((s) => s.text ?? '')
      .join('')
    expect(allText).toBe('Trailing text with a dangling [')
  })
})

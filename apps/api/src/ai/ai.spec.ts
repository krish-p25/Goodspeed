import { MockProvider } from './providers/mock.provider'

describe('MockProvider', () => {
  let provider: MockProvider

  beforeEach(() => {
    provider = new MockProvider()
  })

  it('chat returns content and usage', async () => {
    const result = await provider.chat([{ role: 'user', content: 'hello' }])
    expect(result.content).toBeTruthy()
    expect(result.usage?.totalTokens).toBeGreaterThan(0)
  })

  it('chatStream yields chunks and terminates with done: true', async () => {
    const chunks: { delta: string; done: boolean }[] = []
    for await (const chunk of provider.chatStream([
      { role: 'user', content: 'hello' },
    ])) {
      chunks.push(chunk)
    }
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[chunks.length - 1].done).toBe(true)
  })

  it('embed returns vectors of correct shape', async () => {
    const vectors = await provider.embed(['hello', 'world'])
    expect(vectors.length).toBe(2)
    expect(vectors[0].length).toBe(1536)
  })

  it('custom chat response is returned', async () => {
    const custom = new MockProvider({ chatResponse: 'custom response' })
    const result = await custom.chat([{ role: 'user', content: 'test' }])
    expect(result.content).toBe('custom response')
  })
})

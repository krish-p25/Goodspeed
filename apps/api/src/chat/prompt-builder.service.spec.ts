import { ConfigService } from '@nestjs/config'
import { PromptBuilderService } from './prompt-builder.service'

// Minimal ConfigService stub — only CONVERSATION_HISTORY_WINDOW is read.
const config = {
  get: (_key: string, fallback: string) => fallback,
} as unknown as ConfigService

describe('PromptBuilderService.buildCondenseMessages', () => {
  const builder = new PromptBuilderService(config)

  it('folds history into a standalone-query prompt', () => {
    const messages = builder.buildCondenseMessages({
      question: 'how long does step 2 take',
      history: [
        { role: 'user', content: 'How do I make the banana bread?' },
        { role: 'assistant', content: 'Here are the steps for banana bread...' },
      ],
    })

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    // The system prompt must demand a rewritten query only (no answer).
    expect(messages[0].content).toMatch(/standalone search query/i)
    // The user turn must carry both the history and the fragmentary question.
    expect(messages[1].role).toBe('user')
    expect(messages[1].content).toContain('banana bread')
    expect(messages[1].content).toContain('how long does step 2 take')
  })

  it('still builds a prompt when history is short', () => {
    const messages = builder.buildCondenseMessages({
      question: 'what about the sauce',
      history: [{ role: 'user', content: 'Tell me about the pasta recipe.' }],
    })

    expect(messages[1].content).toContain('pasta recipe')
    expect(messages[1].content).toContain('what about the sauce')
  })
})

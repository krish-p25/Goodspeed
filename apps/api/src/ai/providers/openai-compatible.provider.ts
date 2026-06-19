import OpenAI from 'openai'
import type { LLMProvider } from '../llm-provider.interface'
import type { ChatMessage, ChatOptions, ChatResult, ChatChunk } from '@kb/types'

export interface OpenAICompatibleConfig {
  chatBaseUrl: string
  chatApiKey: string
  chatModel: string
  embedBaseUrl: string
  embedApiKey: string
  embedModel: string
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly chatClient: OpenAI
  private readonly embedClient: OpenAI
  private readonly chatModel: string
  private readonly embedModel: string

  constructor(config: OpenAICompatibleConfig) {
    // Separate clients so chat and embedding can point at different providers
    this.chatClient = new OpenAI({
      apiKey: config.chatApiKey,
      baseURL: config.chatBaseUrl,
    })
    this.embedClient = new OpenAI({
      apiKey: config.embedApiKey,
      baseURL: config.embedBaseUrl,
    })
    this.chatModel = config.chatModel
    this.embedModel = config.embedModel
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const response = await this.chatClient.chat.completions.create({
      model: this.chatModel,
      messages: messages.map(this.toSDKMessage),
      temperature: opts?.temperature,
      max_tokens: opts?.maxTokens,
      stream: false,
    })

    const choice = response.choices[0]
    return {
      content: choice.message.content ?? '',
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    }
  }

  async *chatStream(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const stream = await this.chatClient.chat.completions.create({
      model: this.chatModel,
      messages: messages.map(this.toSDKMessage),
      temperature: opts?.temperature,
      max_tokens: opts?.maxTokens,
      stream: true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      const done = chunk.choices[0]?.finish_reason != null
      yield { delta, done }
    }

    // Guarantee a terminal chunk — some providers omit the finish_reason chunk
    yield { delta: '', done: true }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.embedClient.embeddings.create({
      model: this.embedModel,
      input: texts,
    })

    // Sort by index — the API does not guarantee response order matches input
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding)
  }

  // Translate domain ChatMessage to the openai SDK type.
  // Private — no SDK types leak out of this file.
  private toSDKMessage(
    msg: ChatMessage,
  ): OpenAI.Chat.ChatCompletionMessageParam {
    return { role: msg.role, content: msg.content }
  }
}

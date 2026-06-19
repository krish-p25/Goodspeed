import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as fs from 'fs'
import * as path from 'path'
import type { LLMProvider } from './llm-provider.interface'
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider'
import { MockProvider } from './providers/mock.provider'

interface AiConfig {
  provider: 'openai' | 'mock'
  chat?: { provider?: string; baseUrl: string; model: string }
  embedding?: { provider?: string; baseUrl: string; model: string }
}

@Injectable()
export class AiConfigService {
  // Path is relative to the apps/api directory (NestJS process cwd)
  private readonly configPath = path.resolve(process.cwd(), 'ai.config.json')

  constructor(private readonly config: ConfigService) {}

  /**
   * Returns the correct LLMProvider based on the current ai.config.json.
   * Re-reads the file on every call so provider switches take effect
   * immediately without restarting the app.
   * API keys come from .env via ConfigService — they are never in the
   * config file.
   */
  getProvider(): LLMProvider {
    const raw = fs.readFileSync(this.configPath, 'utf-8')
    const aiConfig: AiConfig = JSON.parse(raw)

    if (aiConfig.provider === 'mock') {
      return new MockProvider()
    }

    // OpenAI-compatible: works with OpenAI, Groq, Together AI,
    // OpenRouter, Ollama — any provider following the Chat Completions spec.
    return new OpenAICompatibleProvider({
      chatBaseUrl: aiConfig.chat?.baseUrl ?? 'https://api.openai.com/v1',
      chatApiKey: this.resolveApiKey(aiConfig.chat?.provider ?? 'openai'),
      chatModel: aiConfig.chat?.model ?? 'gpt-4o-mini',
      embedBaseUrl: aiConfig.embedding?.baseUrl ?? 'https://api.openai.com/v1',
      embedApiKey: this.resolveApiKey(aiConfig.embedding?.provider ?? 'openai'),
      embedModel: aiConfig.embedding?.model ?? 'text-embedding-3-small',
    })
  }

  /**
   * Maps a provider name from ai.config.json to the corresponding env var
   * and returns the key value. Chat and embedding may use different providers
   * (e.g. Groq for chat, OpenAI for embeddings) — each resolves independently.
   */
  private resolveApiKey(provider: string): string {
    const keyMap: Record<string, string> = {
      openai: 'OPENAI_API_KEY',
      groq: 'GROQ_API_KEY',
      together: 'TOGETHER_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      ollama: 'OLLAMA_API_KEY',
    }
    const envVar = keyMap[provider]
    if (!envVar) {
      throw new Error(
        `Unknown provider "${provider}". Add it to the keyMap in AiConfigService.`,
      )
    }
    // Ollama runs locally with no key — fall back to a dummy value so the
    // OpenAI SDK client is satisfied.
    return this.config.get<string>(envVar) ?? 'ollama'
  }
}

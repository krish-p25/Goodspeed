import { Injectable, BadRequestException } from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import type { AiConfigSettings, ProviderName } from '@kb/types'

const VALID_PROVIDERS: ProviderName[] = [
  'openai', 'groq', 'together', 'ollama', 'mock',
]

@Injectable()
export class SettingsService {
  private readonly configPath = path.resolve(process.cwd(), 'ai.config.json')

  read(): AiConfigSettings {
    const raw = fs.readFileSync(this.configPath, 'utf-8')
    const parsed = JSON.parse(raw)

    // Normalise to the full AiConfigSettings shape.
    // ai.config.json may be in mock shorthand { chat: { provider: 'mock' } }
    // so we fill defaults for any missing fields.
    return {
      chat: {
        provider: parsed.chat?.provider ?? 'mock',
        baseUrl: parsed.chat?.baseUrl ?? '',
        model: parsed.chat?.model ?? '',
      },
      embedding: {
        provider: parsed.embedding?.provider ?? 'openai',
        baseUrl: parsed.embedding?.baseUrl ?? 'https://api.openai.com/v1',
        model: parsed.embedding?.model ?? 'text-embedding-3-small',
      },
      chunking: {
        targetTokens: parsed.chunking?.targetTokens ?? 100,
        overlapFraction: parsed.chunking?.overlapFraction ?? 0.12,
      },
    }
  }

  write(settings: AiConfigSettings): void {
    this.validate(settings)

    const config = {
      _comment:
        'Provider behaviour config. Change and save — takes effect on next request, no restart needed. API keys stay in .env and require a restart when changed.',
      chat: {
        provider: settings.chat.provider,
        baseUrl: settings.chat.baseUrl,
        model: settings.chat.model,
      },
      embedding: {
        provider: settings.embedding.provider,
        baseUrl: settings.embedding.baseUrl,
        model: settings.embedding.model,
      },
      chunking: {
        targetTokens: settings.chunking.targetTokens,
        overlapFraction: settings.chunking.overlapFraction,
      },
    }

    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  private validate(settings: AiConfigSettings): void {
    if (!VALID_PROVIDERS.includes(settings.chat.provider)) {
      throw new BadRequestException(
        `Invalid chat provider: ${settings.chat.provider}`
      )
    }
    if (!VALID_PROVIDERS.includes(settings.embedding.provider)) {
      throw new BadRequestException(
        `Invalid embedding provider: ${settings.embedding.provider}`
      )
    }
    if (
      settings.chunking.targetTokens < 50 ||
      settings.chunking.targetTokens > 2000
    ) {
      throw new BadRequestException(
        'targetTokens must be between 50 and 2000'
      )
    }
    if (
      settings.chunking.overlapFraction < 0 ||
      settings.chunking.overlapFraction > 0.5
    ) {
      throw new BadRequestException(
        'overlapFraction must be between 0 and 0.5'
      )
    }
    // Mock provider: baseUrl and model are not required
    if (
      settings.chat.provider !== 'mock' &&
      (!settings.chat.baseUrl || !settings.chat.model)
    ) {
      throw new BadRequestException(
        'baseUrl and model are required for non-mock chat providers'
      )
    }
    if (
      settings.embedding.provider !== 'mock' &&
      (!settings.embedding.baseUrl || !settings.embedding.model)
    ) {
      throw new BadRequestException(
        'baseUrl and model are required for non-mock embedding providers'
      )
    }
  }
}

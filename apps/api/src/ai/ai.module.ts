import { Module } from '@nestjs/common'
import { AiConfigService } from './ai-config.service'
import { LLM_PROVIDER } from './llm-provider.interface'

@Module({
  providers: [
    AiConfigService,
    {
      provide: LLM_PROVIDER,
      inject: [AiConfigService],
      useFactory: (aiConfigService: AiConfigService) => {
        // Proxy delegates to AiConfigService.getProvider() on every method
        // call — the injected LLM_PROVIDER token always reflects whatever
        // ai.config.json currently specifies, with no restart required.
        return new Proxy({} as any, {
          get(_target, prop: string | symbol) {
            // Returning undefined for Promise-protocol properties prevents
            // NestJS's async DI resolver from mistaking this Proxy for a
            // thenable and awaiting it (which would call provider.then()).
            if (prop === 'then' || prop === 'catch' || prop === 'finally') {
              return undefined
            }
            return (...args: any[]) => {
              const provider = aiConfigService.getProvider()
              const method = (provider as any)[prop]
              if (typeof method !== 'function') return method
              return method.call(provider, ...args)
            }
          },
        })
      },
    },
  ],
  exports: [LLM_PROVIDER, AiConfigService],
})
export class AiModule {}

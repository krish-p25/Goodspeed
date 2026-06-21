import { Module } from '@nestjs/common'
import { ChatService } from './chat.service'
import { ChatController } from './chat.controller'
import { PromptBuilderService } from './prompt-builder.service'
import { ConversationService } from './conversation.service'
import { RagModule } from '../rag/rag.module'
import { AiModule } from '../ai/ai.module'
import { SupabaseModule } from '../supabase/supabase.module'
import { UsageModule } from '../usage/usage.module'

@Module({
  imports: [RagModule, AiModule, SupabaseModule, UsageModule],
  controllers: [ChatController],
  providers: [ChatService, PromptBuilderService, ConversationService],
  exports: [ChatService, PromptBuilderService],
})
export class ChatModule {}

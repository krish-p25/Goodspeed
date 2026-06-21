import { Module } from '@nestjs/common'
import { RagService } from './rag.service'
import { ChunkingService } from './chunking.service'
import { EmbeddingService } from './embedding.service'
import { RetrievalService } from './retrieval.service'
import { SupabaseModule } from '../supabase/supabase.module'
import { AiModule } from '../ai/ai.module'
import { UsageModule } from '../usage/usage.module'

@Module({
  imports: [SupabaseModule, AiModule, UsageModule],
  providers: [RagService, ChunkingService, EmbeddingService, RetrievalService],
  exports: [RagService, RetrievalService],
})
export class RagModule {}

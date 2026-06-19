import { Module } from '@nestjs/common'
import { RagService } from './rag.service'
import { ChunkingService } from './chunking.service'
import { EmbeddingService } from './embedding.service'
import { SupabaseModule } from '../supabase/supabase.module'
import { AiModule } from '../ai/ai.module'

@Module({
  imports: [SupabaseModule, AiModule],
  providers: [RagService, ChunkingService, EmbeddingService],
  exports: [RagService],
})
export class RagModule {}

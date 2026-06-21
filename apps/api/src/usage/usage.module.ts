import { Module } from '@nestjs/common'
import { TokenUsageService } from './token-usage.service'
import { UsageController } from './usage.controller'
import { SupabaseModule } from '../supabase/supabase.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [UsageController],
  providers: [TokenUsageService],
  exports: [TokenUsageService],
})
export class UsageModule {}

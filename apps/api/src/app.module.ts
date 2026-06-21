import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { SupabaseModule } from './supabase/supabase.module'
import { AuthModule } from './auth/auth.module'
import { DocumentsModule } from './documents/documents.module'
import { AiModule } from './ai/ai.module'
import { RagModule } from './rag/rag.module'
import { ChatModule } from './chat/chat.module'
import { SettingsModule } from './settings/settings.module'
import { UsageModule } from './usage/usage.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    SupabaseModule,
    AuthModule,
    DocumentsModule,
    AiModule,
    RagModule,
    ChatModule,
    SettingsModule,
    UsageModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

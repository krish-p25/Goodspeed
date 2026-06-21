import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  Sse,
} from '@nestjs/common'
import { Observable } from 'rxjs'
import { AuthGuard } from '../auth/auth.guard'
import { ChatService } from './chat.service'
import { ConversationService } from './conversation.service'

class ChatRequestDto {
  question!: string
  conversationId?: string
}

@Controller('chat')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly conversationService: ConversationService,
  ) {}

  @Post()
  async chat(@Body() dto: ChatRequestDto, @Request() req: any) {
    return this.chatService.chat({
      question: dto.question,
      userId: req.user.id,
      conversationId: dto.conversationId,
      accessToken: req.user.accessToken,
    })
  }

  @Sse('stream')
  chatStream(
    @Query('question') question: string,
    @Query('conversationId') conversationId: string | undefined,
    @Request() req: any,
  ): Observable<{ data: string }> {
    return this.chatService.chatStream({
      question,
      userId: req.user.id,
      conversationId,
      accessToken: req.user.accessToken,
    })
  }

  @Get('conversations')
  listConversations(@Request() req: any) {
    return this.conversationService.listConversations(req.user.id)
  }

  @Get('conversations/:id/messages')
  getMessages(@Param('id') id: string, @Request() req: any) {
    return this.conversationService.getMessages(id, req.user.id)
  }

  @Delete('conversations/:id')
  deleteConversation(@Param('id') id: string, @Request() req: any) {
    return this.conversationService.deleteConversation(id, req.user.id)
  }
}

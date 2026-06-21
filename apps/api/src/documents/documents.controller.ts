import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { AuthGuard } from '../auth/auth.guard'
import { DocumentsService } from './documents.service'
import { CreateDocumentDto } from './dto/create-document.dto'
import { UpdateDocumentDto } from './dto/update-document.dto'
import type { UploadedPdf } from './pdf-extract'

@Controller('documents')
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  findAll(@Request() req: any) {
    return this.documentsService.findAll(req.user.id, req.user.accessToken)
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.documentsService.findOne(id, req.user.id, req.user.accessToken)
  }

  @Post()
  create(@Body() dto: CreateDocumentDto, @Request() req: any) {
    return this.documentsService.create(dto, req.user.id, req.user.accessToken)
  }

  // Extract markdown text from an uploaded PDF (multipart field "file").
  // 25 MB cap keeps a single request from buffering an unreasonable file.
  @Post('extract-pdf')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  extractPdf(@UploadedFile() file: UploadedPdf) {
    return this.documentsService.extractPdf(file)
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @Request() req: any,
  ) {
    return this.documentsService.update(id, dto, req.user.id, req.user.accessToken)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.documentsService.remove(id, req.user.id, req.user.accessToken)
  }
}

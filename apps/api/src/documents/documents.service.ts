import { Injectable, NotFoundException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { CreateDocumentDto } from './dto/create-document.dto'
import { UpdateDocumentDto } from './dto/update-document.dto'

@Injectable()
export class DocumentsService {
  constructor(private supabase: SupabaseService) {}

  async findAll(userId: string, accessToken: string) {
    const client = this.supabase.getUserClient(accessToken)
    const { data, error } = await client
      .from('documents')
      .select('id, title, tags, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })

    if (error) throw new Error(error.message)
    return data
  }

  async findOne(id: string, userId: string, accessToken: string) {
    const client = this.supabase.getUserClient(accessToken)
    const { data, error } = await client
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (error || !data) throw new NotFoundException('Document not found')
    return data
  }

  async create(dto: CreateDocumentDto, userId: string, accessToken: string) {
    const client = this.supabase.getUserClient(accessToken)
    const { data, error } = await client
      .from('documents')
      .insert({
        title: dto.title,
        content: dto.content,
        tags: dto.tags ?? [],
        user_id: userId,
      })
      .select()
      .single()

    if (error || !data) throw new Error(error?.message ?? 'Failed to create document')
    return data
  }

  async update(
    id: string,
    dto: UpdateDocumentDto,
    userId: string,
    accessToken: string,
  ) {
    const client = this.supabase.getUserClient(accessToken)
    const { data, error } = await client
      .from('documents')
      .update({
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.content !== undefined && { content: dto.content }),
        ...(dto.tags !== undefined && { tags: dto.tags }),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error || !data) throw new NotFoundException('Document not found or update failed')
    return data
  }

  async remove(id: string, userId: string, accessToken: string) {
    const client = this.supabase.getUserClient(accessToken)
    const { error } = await client
      .from('documents')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (error) throw new NotFoundException('Document not found or delete failed')
    return { success: true }
  }
}

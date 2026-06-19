import { documentsApi } from '@/lib/api'
import { notFound } from 'next/navigation'
import { DocumentEditor } from './editor'

export default async function DocumentPage({
  params,
}: {
  params: { id: string }
}) {
  let document
  try {
    document = await documentsApi.get(params.id)
  } catch {
    notFound()
  }

  return <DocumentEditor document={document} />
}

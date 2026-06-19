'use server'
import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL

async function getToken() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token
}

export async function createDocument() {
  const token = await getToken()
  const res = await fetch(`${API_URL}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title: 'Untitled Document', content: '' }),
  })
  const doc = await res.json()
  revalidatePath('/documents')
  redirect(`/documents/${doc.id}`)
}

export async function deleteDocument(id: string) {
  const token = await getToken()
  await fetch(`${API_URL}/documents/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  revalidatePath('/documents')
}

'use client'
import { useFormStatus } from 'react-dom'
import { createDocument } from './actions'
import { Button } from '@/components/ui/button'
import { FilePlus, Loader2 } from 'lucide-react'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <FilePlus className="size-4" />
      )}
      {pending ? 'Creating…' : 'New Document'}
    </Button>
  )
}

export function NewDocumentButton() {
  return (
    <form action={createDocument}>
      <SubmitButton />
    </form>
  )
}

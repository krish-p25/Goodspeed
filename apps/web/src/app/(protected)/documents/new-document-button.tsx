'use client'
import { useState } from 'react'
import { createDocument } from './actions'
import { Button } from '@/components/ui/button'
import { FilePlus, Loader2 } from 'lucide-react'

export function NewDocumentButton() {
  const [pending, setPending] = useState(false)

  return (
    <form
      action={createDocument}
      onSubmit={() => setPending(true)}
    >
      <Button type="submit" disabled={pending}>
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <FilePlus className="size-4" />
        )}
        {pending ? 'Creating…' : 'New Document'}
      </Button>
    </form>
  )
}

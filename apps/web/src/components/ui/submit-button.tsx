'use client'
import { useFormStatus } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Submit button for server-action forms. While the action is in flight — and
 * crucially while the post-action redirect navigates and the next page
 * compiles/loads — useFormStatus().pending stays true, so the button greys out
 * (via the Button's disabled styles) and shows a spinner. This gives immediate
 * feedback that the request was accepted and is being processed.
 */
export function SubmitButton({
  children,
  pendingText,
  ...props
}: React.ComponentProps<typeof Button> & { pendingText?: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" {...props} disabled={pending} aria-busy={pending}>
      {pending ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          {pendingText ?? children}
        </>
      ) : (
        children
      )}
    </Button>
  )
}

import { RefreshCw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * The plain retry state for a dashboard/budget section that failed to load
 * (F1 audit B2).
 *
 * Before this, both surfaces showed the household a developer message — a
 * paragraph about `vp run db:migrate` ("If you just pulled this branch…") and
 * the raw `error.message` inside a monospace block. A first-run family has no
 * branch, cannot run migrations, and should not be reading transport errors;
 * the only useful action — try again — was buried under them.
 *
 * Two deliberate omissions:
 *   - **No raw error text.** Server errors can carry payload fragments, and
 *     the message is never actionable for the person reading it.
 *   - **No developer instructions.** Migration advice belongs in the runbook.
 *
 * `label` keeps each surface's existing title ("this budget", "your
 * dashboard", …) so the state still says WHAT failed.
 */
export function LoadErrorCard({
  label,
  isRetrying,
  onRetry,
}: {
  label: string
  isRetrying: boolean
  onRetry: () => void
}) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="size-5" aria-hidden />
          Couldn&apos;t load {label}
        </CardTitle>
        <CardDescription>
          Something went wrong while loading this. Nothing was changed — your
          data is safe. Try again in a moment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          className="w-fit"
          disabled={isRetrying}
          onClick={onRetry}
        >
          <RefreshCw className="size-4" aria-hidden />
          {isRetrying ? "Retrying…" : "Try again"}
        </Button>
      </CardContent>
    </Card>
  )
}

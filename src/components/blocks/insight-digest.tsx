import { FileQuestion, Inbox, TriangleAlert } from "lucide-react"

import { InsightCard } from "@/components/blocks/insight-card"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { InsightReport, InsightSkipped } from "@/lib/insights"

// =============================================================================
// PER-227 — the digest's honesty half: render what the engine chose NOT to
// say. ADR-0059 gives every derivation a `skipped` reason and isolates throws
// into `failedCount` precisely "so the digest can tell 'nothing to say' from
// 'failed'" — that duty lives HERE, not in `InsightCard` (whose null-on-empty
// behavior the dashboard deliberately keeps byte-identical; its own empty
// state is a DEFERRED follow-up, out of this slice).
//
// Zero per-insight branches: this component knows the ENVELOPE only. Skip
// lines are generic (id + the engine's own reason, the id humanized by
// underscore substitution — never a hand-written label per derivation), and
// the failed indicator renders iff `failedCount > 0`, so an engine failure can
// never masquerade as "nothing to say".
// =============================================================================

/** "savings_flow" → "savings flow" — generic humanization, no per-id table. */
function humanizeInsightId(id: string): string {
  return id.replace(/_/g, " ")
}

export function InsightDigest({ report }: { report: InsightReport }) {
  const isNothingToSay =
    report.insights.length === 0 &&
    report.skipped.length === 0 &&
    report.failedCount === 0

  return (
    <div className="flex flex-col gap-6" data-testid="insight-digest">
      <InsightCard report={report} />
      {report.failedCount > 0 ? (
        <DigestFailedIndicator failedCount={report.failedCount} />
      ) : null}
      {report.skipped.length > 0 ? (
        <DigestSkippedSection skipped={report.skipped} />
      ) : null}
      {/* A 0-insight / 0-skipped / 0-failed report cannot come from the
          current engine (every derivation either surfaces or skips), but the
          honest state must exist anyway: an empty report renders THIS, never
          a blank page. */}
      {isNothingToSay ? <DigestNothingToSayCard /> : null}
    </div>
  )
}

function DigestFailedIndicator({ failedCount }: { failedCount: number }) {
  return (
    <Card className="border-dashed" data-testid="digest-failed">
      <CardContent className="flex items-center gap-3 py-6">
        <TriangleAlert
          className="size-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <p className="text-sm">
          {failedCount} insight{failedCount === 1 ? "" : "s"} failed to compute
          and {failedCount === 1 ? "is" : "are"} not shown. The rest of this
          digest is still valid, but treat it as incomplete.
        </p>
      </CardContent>
    </Card>
  )
}

function DigestSkippedSection({ skipped }: { skipped: InsightSkipped[] }) {
  return (
    <Card data-testid="digest-skipped-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileQuestion className="size-5 text-muted-foreground" aria-hidden />
          Not shown for this month
        </CardTitle>
        <CardDescription>
          These insights ran but had nothing to surface for this period. Each
          line is the engine&apos;s own reason — a deliberate silence, never an
          error.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1 text-sm">
          {skipped.map((entry) => (
            <li
              key={entry.id}
              data-testid={`digest-skipped-${entry.id}`}
              className="flex flex-wrap gap-x-2"
            >
              <span className="font-medium">{humanizeInsightId(entry.id)}</span>
              <span className="text-muted-foreground">{entry.reason}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function DigestNothingToSayCard() {
  return (
    <Card className="border-dashed" data-testid="digest-nothing-to-say">
      <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
        <Inbox className="size-8 text-muted-foreground" aria-hidden />
        <p className="text-lg font-medium">Nothing to say about this month</p>
        <p className="max-w-md text-sm text-muted-foreground">
          The insights engine had no finding — and no skipped item — for this
          period. As your recorded history grows, Permoney will start speaking
          up here on its own.
        </p>
      </CardContent>
    </Card>
  )
}

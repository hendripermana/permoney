import * as React from "react"
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  CalendarX2,
  CircleCheckBig,
  CircleSlash,
  Coins,
  FileJson,
  Layers,
  Loader2,
  PiggyBank,
  ScrollText,
  ShieldCheck,
  Store,
  Tags,
  Wallet,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import {
  parseSureBundle,
  summarizeSureBundle,
  type SureBundlePreview,
  type SureHeldReason,
} from "@/lib/sure-migration"
import { runSureMigrationFn } from "@/server/sure-migration"
import { transactionCollection } from "@/lib/collections"

// PER-171 / ADR-0041 §11 — the guided Sure migration importer. Distinct from the
// PER-151 CSV column-mapping wizard: this is a whole-bundle, multi-entity
// orchestration. The migration server fn (`runSureMigrationFn`) commits in ONE
// atomic call, so the pre-confirm preview is computed in the browser by running
// the SAME reader (`parseSureBundle` + `summarizeSureBundle`) the server uses.
// Phase-1 balances are intentionally PARTIAL (transfers/splits/non-importable
// accounts are held), so the UI's job is honest surfacing: every line is either
// crossing into the ledger now or visibly held for a later crossing — nothing is
// silently dropped, and the reconciliation gap is stated plainly.

export const Route = createFileRoute("/_protected/import_/sure")({
  ssr: false,
  staticData: { title: "Migrate from Sure" },
  loader: async () => {
    // Collections are client-only; preload so /transactions is warm after promote
    // and useLiveQuery elsewhere never starts syncing during a render commit.
    await transactionCollection.preload()
    return null
  },
  component: SureImportPage,
})

type SureMigrationResult = Awaited<ReturnType<typeof runSureMigrationFn>>
type Stage = "upload" | "review" | "done"

// Mirror of the server's bundle ceiling; pre-checked here for a friendly message
// rather than a thrown server error on a 64 MiB+ upload.
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

const HELD_REASONS: Record<
  SureHeldReason,
  { label: string; detail: string; icon: typeof ArrowRightLeft }
> = {
  transfer: {
    label: "Transfers",
    detail:
      "Paired moves between your own accounts — imported in a later step.",
    icon: ArrowRightLeft,
  },
  split: {
    label: "Split transactions",
    detail: "One payment divided across several categories.",
    icon: Layers,
  },
  nonImportableAccount: {
    label: "Investment & tracked-asset activity",
    detail: "These balances are tracked by valuation, not by each transaction.",
    icon: PiggyBank,
  },
  currencyMismatch: {
    label: "Currency mismatches",
    detail: "The transaction's currency differs from its account.",
    icon: Coins,
  },
}

function SureImportPage() {
  const router = useRouter()

  const [stage, setStage] = React.useState<Stage>("upload")
  const [fileName, setFileName] = React.useState("")
  const [bundleText, setBundleText] = React.useState("")
  const [preview, setPreview] = React.useState<SureBundlePreview | null>(null)
  const [result, setResult] = React.useState<SureMigrationResult | null>(null)

  // File read + parse is an event handler, not an effect (no-use-effect rule).
  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (file.size > MAX_BUNDLE_BYTES) {
      toast.error("That bundle is over the 64 MiB limit.")
      return
    }
    const text = await file.text()
    const summary = summarizeSureBundle(parseSureBundle(text))
    setFileName(file.name)
    setBundleText(text)
    setPreview(summary)
    setResult(null)
    setStage("review")
  }

  const runMutation = useMutation({
    mutationFn: () =>
      runSureMigrationFn({ data: { filename: fileName, bundle: bundleText } }),
    onSuccess: async (migration) => {
      setResult(migration)
      setStage("done")
      // Sync the local ledger with the server source of truth so /transactions
      // reflects the promoted rows the instant the user navigates there.
      await transactionCollection.utils.refetch()
      if (migration.replayed) {
        toast.info("Already imported — nothing was duplicated.")
      } else {
        toast.success(
          `Imported ${migration.transactions.promotedThisRun} transaction(s).`
        )
      }
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Migration failed."),
  })

  const restart = () => {
    setStage("upload")
    setFileName("")
    setBundleText("")
    setPreview(null)
    setResult(null)
  }

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-8 p-4 md:p-6 lg:p-8">
            <header className="flex max-w-3xl flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-emerald-600 uppercase dark:text-emerald-400">
                <ShieldCheck size={16} />
                Sure migration
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-balance">
                Bring your whole Sure history across
              </h1>
              <p className="text-lg text-muted-foreground">
                Upload your Sure export and we'll account for every line — what
                crosses into your ledger now, and what we hold for a later step.
                Nothing is dropped.
              </p>
              <StageRail stage={stage} />
            </header>

            {stage === "upload" && <UploadStage onFile={handleFile} />}

            {stage === "review" && preview && (
              <ReviewStage
                fileName={fileName}
                preview={preview}
                onBack={restart}
                onConfirm={() => runMutation.mutate()}
                running={runMutation.isPending}
              />
            )}

            {stage === "done" && result && (
              <DoneStage
                result={result}
                onViewTransactions={() =>
                  void router.navigate({ to: "/transactions" })
                }
                onImportAnother={restart}
              />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

// ===========================================================================
// Stage rail
// ===========================================================================

function StageRail({ stage }: { stage: Stage }) {
  const steps: { id: Stage; label: string }[] = [
    { id: "upload", label: "Upload" },
    { id: "review", label: "Review" },
    { id: "done", label: "Done" },
  ]
  const activeIndex = steps.findIndex((s) => s.id === stage)
  return (
    <ol className="flex flex-wrap items-center gap-2 pt-1 text-sm">
      {steps.map((step, index) => (
        <React.Fragment key={step.id}>
          <li
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1 font-semibold transition-colors",
              index < activeIndex && "text-emerald-600 dark:text-emerald-400",
              index === activeIndex &&
                "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
              index > activeIndex && "text-muted-foreground"
            )}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-xs",
                index <= activeIndex
                  ? "bg-emerald-600 text-white"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {index + 1}
            </span>
            {step.label}
          </li>
          {index < steps.length - 1 && (
            <ArrowRight size={14} className="text-muted-foreground" />
          )}
        </React.Fragment>
      ))}
    </ol>
  )
}

// ===========================================================================
// Stage 1 — upload
// ===========================================================================

function UploadStage({
  onFile,
}: {
  onFile: (event: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <Card className="max-w-2xl overflow-hidden">
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            <FileJson size={22} />
          </span>
          <div>
            <CardTitle className="text-xl">Upload your Sure export</CardTitle>
            <CardDescription>
              Choose the <code className="font-mono">all.ndjson</code> file from
              your Sure data export.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <label
          htmlFor="sure-bundle"
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-emerald-200 bg-emerald-50/50 py-10 text-center transition-colors hover:border-emerald-400 hover:bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 dark:hover:border-emerald-700"
        >
          <ScrollText className="text-emerald-600 dark:text-emerald-400" />
          <span className="font-semibold">Choose your all.ndjson file</span>
          <span className="text-xs text-muted-foreground">
            We read it in your browser first — nothing imports until you
            confirm.
          </span>
          <input
            id="sure-bundle"
            type="file"
            accept=".ndjson,.jsonl,.json,.txt"
            onChange={onFile}
            className="sr-only"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Looking to import a bank statement instead?{" "}
          <Link
            to="/import"
            className="font-semibold text-emerald-600 underline-offset-4 hover:underline dark:text-emerald-400"
          >
            Use the CSV / QIF wizard
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  )
}

// ===========================================================================
// Stage 2 — review (client preview, the honest manifest)
// ===========================================================================

function ReviewStage({
  fileName,
  preview,
  onBack,
  onConfirm,
  running,
}: {
  fileName: string
  preview: SureBundlePreview
  onBack: () => void
  onConfirm: () => void
  running: boolean
}) {
  const t = preview.transactions
  const ignoredTotal = Object.values(preview.ignoredEntities).reduce(
    (sum, n) => sum + n,
    0
  )
  const heldReasons = (Object.keys(HELD_REASONS) as SureHeldReason[]).filter(
    (reason) => t.heldByReason[reason] > 0
  )
  const hasHeld =
    t.held > 0 ||
    t.zeroAmountSkipped > 0 ||
    t.invalidDateSkipped > 0 ||
    preview.accounts.held > 0

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Reviewing <span className="font-semibold">{fileName}</span>
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Crossing now */}
        <Card className="border-emerald-200 dark:border-emerald-900">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CircleCheckBig
                size={18}
                className="text-emerald-600 dark:text-emerald-400"
              />
              <CardTitle className="text-lg">
                Crossing into your ledger
              </CardTitle>
            </div>
            <CardDescription>
              Created or matched on import, then promoted to your ledger.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <ManifestRow
              icon={Wallet}
              label="Accounts"
              value={preview.accounts.total}
              hint={
                preview.accounts.held > 0
                  ? `${preview.accounts.importable} import activity`
                  : undefined
              }
            />
            <ManifestRow
              icon={Tags}
              label="Categories"
              value={preview.categories}
            />
            <ManifestRow
              icon={Store}
              label="Merchants"
              value={preview.merchants}
            />
            <Separator className="my-2" />
            <ManifestRow
              icon={CircleCheckBig}
              label="Transactions to your ledger"
              value={t.promotable}
              emphasis
            />
          </CardContent>
        </Card>

        {/* Held for a later crossing */}
        <Card
          className={cn(
            hasHeld
              ? "border-amber-200 dark:border-amber-900/60"
              : "border-border"
          )}
        >
          <CardHeader>
            <div className="flex items-center gap-2">
              <CircleSlash
                size={18}
                className={cn(
                  hasHeld
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
                )}
              />
              <CardTitle className="text-lg">Held for a later step</CardTitle>
            </div>
            <CardDescription>
              {hasHeld
                ? "Kept safely in the import, not yet on your ledger."
                : "Nothing held — every transaction in this bundle will import."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {heldReasons.map((reason) => (
              <HeldRow
                key={reason}
                icon={HELD_REASONS[reason].icon}
                label={HELD_REASONS[reason].label}
                detail={HELD_REASONS[reason].detail}
                count={t.heldByReason[reason]}
              />
            ))}
            {t.zeroAmountSkipped > 0 && (
              <HeldRow
                icon={CircleSlash}
                label="Zero-amount entries"
                detail="Entries with no value to post."
                count={t.zeroAmountSkipped}
              />
            )}
            {t.invalidDateSkipped > 0 && (
              <HeldRow
                icon={CalendarX2}
                label="Unreadable dates"
                detail="Rows whose date couldn't be parsed."
                count={t.invalidDateSkipped}
              />
            )}
            {!hasHeld && (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                Clean bundle — all {t.total} transactions are ready to import.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {t.held > 0 && <ReconciliationNote />}

      {(preview.malformedLines > 0 || ignoredTotal > 0) && (
        <p className="text-xs text-muted-foreground">
          {preview.malformedLines > 0 &&
            `${preview.malformedLines} line(s) couldn't be read and were skipped. `}
          {ignoredTotal > 0 &&
            `${ignoredTotal} entr(ies) for features not yet supported were kept in the import for later.`}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack} disabled={running}>
          <ArrowLeft size={16} className="mr-2" />
          Choose a different file
        </Button>
        <Button
          size="lg"
          onClick={onConfirm}
          disabled={running || t.promotable === 0}
          className="rounded-full"
        >
          {running ? (
            <Loader2 size={16} className="mr-2 animate-spin" />
          ) : (
            <ArrowRight size={16} className="mr-2" />
          )}
          Import {t.promotable} transaction{t.promotable === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  )
}

// ===========================================================================
// Stage 3 — done (authoritative server result)
// ===========================================================================

function DoneStage({
  result,
  onViewTransactions,
  onImportAnother,
}: {
  result: SureMigrationResult
  onViewTransactions: () => void
  onImportAnother: () => void
}) {
  const t = result.transactions
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              <CircleCheckBig size={22} />
            </span>
            <div>
              <CardTitle className="text-xl">
                {result.replayed ? "Already imported" : "Migration complete"}
              </CardTitle>
              <CardDescription>
                {result.replayed
                  ? "This exact export was imported before — nothing was duplicated."
                  : "Your Sure history is now part of your Permoney ledger."}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <span className="text-5xl font-extrabold tracking-tight tabular-nums">
              {t.promotedThisRun}
            </span>
            <span className="pb-1 text-lg text-muted-foreground">
              transaction{t.promotedThisRun === 1 ? "" : "s"} added to your
              ledger
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <ResultStat
              icon={Wallet}
              label="Accounts"
              created={result.accounts.created}
              reused={result.accounts.reused}
            />
            <ResultStat
              icon={Tags}
              label="Categories"
              created={result.categories.created}
              reused={result.categories.reused}
            />
            <ResultStat
              icon={Store}
              label="Merchants"
              created={result.merchants.created}
              reused={result.merchants.reused}
            />
          </div>

          {t.held > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">Held for a later step:</span>
              <Badge
                variant="outline"
                className="border-amber-400 text-amber-700 dark:text-amber-300"
              >
                {t.held} transaction{t.held === 1 ? "" : "s"}
              </Badge>
              {t.zeroAmountSkipped > 0 && (
                <Badge variant="outline">
                  {t.zeroAmountSkipped} zero-amount
                </Badge>
              )}
              {t.invalidDateSkipped > 0 && (
                <Badge variant="outline">
                  {t.invalidDateSkipped} unreadable date
                </Badge>
              )}
            </div>
          )}

          {t.held > 0 && <ReconciliationNote />}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onImportAnother}>
          <ArrowLeft size={16} className="mr-2" />
          Import another export
        </Button>
        <Button size="lg" onClick={onViewTransactions} className="rounded-full">
          View transactions
          <ArrowRight size={16} className="ml-2" />
        </Button>
      </div>
    </div>
  )
}

// ===========================================================================
// Shared presentational pieces
// ===========================================================================

function ManifestRow({
  icon: Icon,
  label,
  value,
  hint,
  emphasis,
}: {
  icon: typeof Wallet
  label: string
  value: number
  hint?: string
  emphasis?: boolean
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Icon
        size={18}
        className={cn(
          emphasis
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground"
        )}
      />
      <span className={cn("flex-1", emphasis && "font-semibold")}>{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      <span
        className={cn(
          "tabular-nums",
          emphasis ? "text-xl font-bold" : "font-semibold"
        )}
      >
        {value}
      </span>
    </div>
  )
}

function HeldRow({
  icon: Icon,
  label,
  detail,
  count,
}: {
  icon: typeof ArrowRightLeft
  label: string
  detail: string
  count: number
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-100 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
      <Icon
        size={18}
        className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">{label}</span>
          <span className="font-bold tabular-nums">{count}</span>
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

function ResultStat({
  icon: Icon,
  label,
  created,
  reused,
}: {
  icon: typeof Wallet
  label: string
  created: number
  reused: number
}) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon size={16} />
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums">{created}</div>
      <div className="text-xs text-muted-foreground">
        new{reused > 0 ? ` · ${reused} reused` : ""}
      </div>
    </div>
  )
}

function ReconciliationNote() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <ArrowRightLeft
        size={18}
        className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <p className="text-amber-900 dark:text-amber-100">
        <span className="font-semibold">A few balances won't match yet.</span>{" "}
        Transfers and split transactions aren't migrated in this step, so any
        account that used them will finish reconciling once transfers are
        imported in a later step. Your full export is kept safely until then.
      </p>
    </div>
  )
}

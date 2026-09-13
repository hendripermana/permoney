import * as React from "react"
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { parseSureBundle, summarizeSureBundle } from "@/lib/sure-migration"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  getSureImportProgressFn,
  runSureMigrationFn,
} from "@/server/sure-migration"
import { getSettingsOverviewFn, SETTINGS_OVERVIEW_KEY } from "@/server/settings"
import { transactionCollection } from "@/lib/collections"
import {
  DoneStage,
  type ImportProgress,
  ReviewStage,
  type Stage,
  SureImportHeader,
  UploadStage,
} from "./-sure-import-ui"

// PER-171 / ADR-0041 §11 — the guided Sure migration importer. Distinct from the
// PER-151 CSV column-mapping wizard: this is a whole-bundle, multi-entity
// orchestration. The migration server fn (`runSureMigrationFn`) commits in ONE
// atomic call, so the pre-confirm preview is computed in the browser by running
// the SAME reader (`parseSureBundle` + `summarizeSureBundle`) the server uses.
// Phase-1 balances are intentionally PARTIAL (transfers/splits/non-importable
// accounts are held); this route owns the read → preview → confirm → result flow
// while `-sure-import-ui` owns the honest, fully-reconciled presentation.

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

// Mirror of the server's bundle ceiling; pre-checked here for a friendly message
// rather than a thrown server error on a 64 MiB+ upload.
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

function SureImportPage() {
  const router = useRouter()

  // PER-186 — the confirm step is the exact place the original incident
  // happened (import landed in the wrong account, silently, because nothing on
  // screen said which family it was going into). Shares the sidebar's
  // SETTINGS_OVERVIEW_KEY cache entry, so this is normally already resolved by
  // the time the user reaches the review stage — no extra request.
  const { data: overview } = useQuery({
    queryKey: SETTINGS_OVERVIEW_KEY,
    queryFn: () => getSettingsOverviewFn(),
  })

  const [stage, setStage] = React.useState<Stage>("upload")
  const [fileName, setFileName] = React.useState("")
  const [bundleText, setBundleText] = React.useState("")
  const [preview, setPreview] = React.useState<ReturnType<
    typeof summarizeSureBundle
  > | null>(null)
  const [result, setResult] = React.useState<SureMigrationResult | null>(null)

  // File read + parse is an event handler, not an effect (no-use-effect rule).
  // The bundle string lives only in component state and flows solely to the
  // server fn — never localStorage, a persisted collection, or a log (PII).
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

  // PER-188 — client-minted UUIDv7, the key `getSureImportProgressFn` polls
  // by. Minted fresh per attempt (not per page load) so a retry after a
  // failure gets its own progress lineage instead of resuming a stale one.
  const [importId, setImportId] = React.useState<string | null>(null)
  const [importStartedAt, setImportStartedAt] = React.useState<number | null>(
    null
  )

  const runMutation = useMutation({
    mutationFn: (id: string) =>
      runSureMigrationFn({
        data: { filename: fileName, bundle: bundleText, importId: id },
      }),
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

  // Ephemeral, observational only (PER-188 locked design) — never awaited,
  // never consulted for correctness. Stops the instant the mutation above
  // resolves, which is when the typed result actually lands.
  const { data: progressSnapshot } = useQuery({
    queryKey: ["sure-import-progress", importId],
    queryFn: () =>
      getSureImportProgressFn({ data: { importId: importId as string } }),
    enabled: runMutation.isPending && importId !== null,
    refetchInterval: 900,
  })

  const progress: ImportProgress | null =
    runMutation.isPending && importStartedAt !== null
      ? { phase: progressSnapshot?.phase ?? null, startedAt: importStartedAt }
      : null

  const startImport = () => {
    const id = createUuidV7()
    setImportId(id)
    setImportStartedAt(Date.now())
    runMutation.mutate(id)
  }

  const restart = () => {
    setStage("upload")
    setFileName("")
    setBundleText("")
    setPreview(null)
    setResult(null)
    setImportId(null)
    setImportStartedAt(null)
  }

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-8 p-4 md:p-6 lg:p-8">
            <SureImportHeader stage={stage} />

            {stage === "upload" && (
              <UploadStage
                onFile={handleFile}
                csvImportHref={
                  <Link
                    to="/import"
                    className="font-semibold text-emerald-600 underline-offset-4 hover:underline dark:text-emerald-400"
                  >
                    Use the CSV / QIF wizard
                  </Link>
                }
              />
            )}

            {stage === "review" && preview && (
              <ReviewStage
                fileName={fileName}
                preview={preview}
                actingEmail={overview?.profile.email}
                onBack={restart}
                onConfirm={startImport}
                running={runMutation.isPending}
                progress={progress}
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

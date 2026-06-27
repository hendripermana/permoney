import { Link } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// PER-166 — public front door. Per DESIGN.md (Wise theme) + frontend-design
// pass: the page's thesis is Permoney's core invariant — a double-entry ledger
// that ALWAYS balances. Instead of describing that with generic icon cards, the
// hero demonstrates it: a small ledger whose figures foot exactly (Income −
// Spending = Net), closed with the accounting double-rule (border-style: double)
// in tabular numerals. That ledger is the single signature; everything else
// stays quiet. Brand colors come from the `wise-*` design tokens; "calt" is on
// <body> globally.

// CTA pills opt into the DESIGN.md physical scale(1.05) hover / scale(0.95)
// active — kept here (not in the Button variant) because the grow only reads
// well on auto-width pills, and disabled under reduced-motion.
const CTA_GROW =
  "transition-transform hover:scale-105 active:scale-95 motion-reduce:hover:scale-100"

interface LedgerRow {
  label: string
  amount: string
  tone: "in" | "out"
}

// Figures foot exactly: 12,400,000 − 8,250,000 = 4,150,000. A finance app should
// never show a demo ledger that doesn't reconcile.
const LEDGER_ROWS: ReadonlyArray<LedgerRow> = [
  { label: "Income", amount: "+ Rp 12,400,000", tone: "in" },
  { label: "Spending", amount: "− Rp 8,250,000", tone: "out" },
]
const LEDGER_NET = "+ Rp 4,150,000"

interface Pillar {
  term: string
  detail: string
}

const PILLARS: ReadonlyArray<Pillar> = [
  {
    term: "Double-entry",
    detail:
      "Every transaction has two sides, so the books can't silently drift.",
  },
  {
    term: "Shared by the family",
    detail:
      "One reconciled picture for the whole household, not scattered apps.",
  },
  {
    term: "Reports from the source",
    detail:
      "Net worth and cash flow computed from the ledger, not a spreadsheet.",
  },
]

function WordMark() {
  return (
    <span className="text-xl font-black tracking-tight text-wise-ink dark:text-white">
      Permoney
    </span>
  )
}

function LedgerCard() {
  return (
    <div className="w-full rounded-3xl border border-[rgba(14,15,12,0.12)] bg-white p-6 shadow-[0_0_0_1px_rgba(14,15,12,0.06)] sm:p-8 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold tracking-tight text-wise-warm-dark dark:text-zinc-400">
          This month
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-wise-mint px-2.5 py-1 text-xs font-semibold text-wise-dark-green">
          In − Out = Net
          <span aria-hidden>✓</span>
        </span>
      </div>

      <dl className="mt-6 space-y-3">
        {LEDGER_ROWS.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-6"
          >
            <dt className="text-base font-medium text-wise-warm-dark dark:text-zinc-300">
              {row.label}
            </dt>
            <dd
              className={cn(
                "font-mono text-base tabular-nums",
                row.tone === "in"
                  ? "text-wise-dark-green dark:text-wise-green"
                  : "text-wise-ink dark:text-zinc-200"
              )}
            >
              {row.amount}
            </dd>
          </div>
        ))}
      </dl>

      {/* Single rule, then the accounting double-rule under the closing total. */}
      <div className="mt-4 flex items-baseline justify-between gap-6 border-t border-[rgba(14,15,12,0.12)] pt-4 dark:border-white/15">
        <dt className="text-base font-semibold tracking-tight text-wise-ink dark:text-white">
          Net
        </dt>
        <dd className="border-b-[3px] border-double border-wise-ink pb-1 font-mono text-lg font-semibold text-wise-dark-green tabular-nums dark:border-white dark:text-wise-green">
          {LEDGER_NET}
        </dd>
      </div>
    </div>
  )
}

export function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col bg-wise-canvas">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <WordMark />
        <nav className="flex items-center gap-2">
          <Button
            asChild
            variant="wiseSecondary"
            size="lg"
            className={CTA_GROW}
          >
            <Link to="/login">Log in</Link>
          </Button>
          <Button asChild variant="wise" size="lg" className={CTA_GROW}>
            <Link to="/signup">Sign up</Link>
          </Button>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-16">
        <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="flex flex-col items-start gap-7">
            <h1 className="max-w-2xl text-5xl leading-[0.85] font-black tracking-tight text-wise-ink sm:text-6xl lg:text-7xl dark:text-white">
              Family money that always balances.
            </h1>

            <p className="max-w-xl text-lg font-semibold text-wise-warm-dark sm:text-xl dark:text-zinc-300">
              Permoney keeps every account, transfer, and split in one
              double-entry ledger — so the numbers always reconcile, and you
              always know where the household stands.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                asChild
                variant="wise"
                size="lg"
                className={cn("h-12 px-8 text-base font-semibold", CTA_GROW)}
              >
                <Link to="/signup">Get started — it's free</Link>
              </Button>
              <Button
                asChild
                variant="wiseSecondary"
                size="lg"
                className={cn("h-12 px-8 text-base font-semibold", CTA_GROW)}
              >
                <Link to="/login">I already have an account</Link>
              </Button>
            </div>
          </section>

          <LedgerCard />
        </div>

        {/* Quiet hairline-divided pillars — content as a ledger-like column set,
            not decorative icon cards. */}
        <dl className="mt-20 grid gap-px overflow-hidden rounded-2xl border border-[rgba(14,15,12,0.12)] bg-[rgba(14,15,12,0.12)] sm:grid-cols-3 dark:border-white/10 dark:bg-white/10">
          {PILLARS.map((pillar) => (
            <div
              key={pillar.term}
              className="flex flex-col gap-1.5 bg-wise-canvas p-6"
            >
              <dt className="text-sm font-semibold tracking-tight text-wise-ink dark:text-white">
                {pillar.term}
              </dt>
              <dd className="text-sm font-medium text-wise-warm-dark dark:text-zinc-400">
                {pillar.detail}
              </dd>
            </div>
          ))}
        </dl>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-sm font-medium text-wise-gray">
        © {new Date().getFullYear()} Permoney — your money, clearly.
      </footer>
    </div>
  )
}

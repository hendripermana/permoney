import { Link } from "@tanstack/react-router"
import { BarChart3, ShieldCheck, Users, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// PER-166 — public front door. A minimal, branded landing per DESIGN.md (Wise
// theme): billboard-weight display headline (weight 900, line-height 0.85),
// lime-green pill CTAs with dark-green text, ring-shadowed cards. Brand colors
// come from the `wise-*` design tokens (styles.css), never raw hex. "calt" is
// enabled globally on <body>. Full marketing content is out of scope; this is a
// clean branded entry with working Log in / Sign up.

// CTA pills opt into the DESIGN.md physical scale(1.05) hover / scale(0.95)
// active. Kept here (not in the Button variant) because the grow only reads well
// on auto-width pills, not full-width form submits.
const CTA_GROW = "hover:scale-105 active:scale-95"

interface ValueProp {
  icon: typeof Wallet
  title: string
  body: string
}

const VALUE_PROPS: ReadonlyArray<ValueProp> = [
  {
    icon: Wallet,
    title: "One honest ledger",
    body: "Every account, transfer, and split in a single double-entry ledger that always balances.",
  },
  {
    icon: Users,
    title: "Built for families",
    body: "Shared categories, members, and budgets — so the whole household sees the same picture.",
  },
  {
    icon: BarChart3,
    title: "Reports that mean something",
    body: "Net worth, cash flow, and budgets computed from the source of truth, not a spreadsheet guess.",
  },
]

function WordMark() {
  return (
    <span className="text-xl font-black tracking-tight text-wise-ink dark:text-white">
      Permoney
    </span>
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
        <section className="flex flex-col items-start gap-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-wise-mint px-4 py-1.5 text-sm font-semibold text-wise-dark-green">
            <ShieldCheck className="size-4" />
            Money without the headache
          </span>

          <h1 className="max-w-4xl text-5xl leading-[0.85] font-black tracking-tight text-wise-ink sm:text-7xl lg:text-8xl dark:text-white">
            Family money that finally makes sense.
          </h1>

          <p className="max-w-2xl text-lg font-semibold text-wise-warm-dark sm:text-xl dark:text-zinc-300">
            Permoney is a calm, trustworthy home for every transaction, budget,
            and account your household runs on — built on a ledger that never
            lies to you.
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

        <section className="mt-20 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {VALUE_PROPS.map(({ icon: Icon, title, body }) => (
            <article
              key={title}
              className={cn(
                "flex flex-col gap-3 rounded-3xl border border-[rgba(14,15,12,0.12)] p-6",
                "shadow-[0_0_0_1px_rgba(14,15,12,0.06)] dark:border-white/10"
              )}
            >
              <span className="flex size-11 items-center justify-center rounded-full bg-wise-mint text-wise-dark-green">
                <Icon className="size-5" />
              </span>
              <h2 className="text-xl font-semibold tracking-tight text-wise-ink dark:text-white">
                {title}
              </h2>
              <p className="text-sm font-medium text-wise-warm-dark dark:text-zinc-400">
                {body}
              </p>
            </article>
          ))}
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-sm font-medium text-wise-gray">
        © {new Date().getFullYear()} Permoney — your money, clearly.
      </footer>
    </div>
  )
}

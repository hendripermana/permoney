// Instrument kinds (PER-232 / ADR-0051) — the single client-side source of truth
// for the six market-priced instrument kinds and their human labels. The server
// mirrors these tokens in its Zod `inlineInstrumentSchema` enum (the DB CHECK is
// the backstop); this module owns the token → label mapping the UI renders, so
// the add-holding dialog, the buy/sell trade dialog, and the holdings list all
// agree without copy-pasting the list. Pure and framework-free.

export const INSTRUMENT_KINDS = [
  "mutual_fund",
  "metal",
  "stock",
  "crypto",
  "bond",
  "deposit",
] as const

export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number]

const INSTRUMENT_KIND_LABELS: Record<InstrumentKind, string> = {
  mutual_fund: "Mutual fund",
  metal: "Metal",
  stock: "Stock",
  crypto: "Crypto",
  bond: "Bond",
  deposit: "Deposit",
}

// Select-ready {value, label} options, in the canonical kind order.
export const INSTRUMENT_KIND_OPTIONS: ReadonlyArray<{
  value: InstrumentKind
  label: string
}> = INSTRUMENT_KINDS.map((value) => ({
  value,
  label: INSTRUMENT_KIND_LABELS[value],
}))

// Human label for a stored kind token; falls back to the raw token for any
// value outside the known set (never throws — the DB stores the machine token).
export function instrumentKindLabel(kind: string): string {
  return (INSTRUMENT_KIND_LABELS as Record<string, string>)[kind] ?? kind
}

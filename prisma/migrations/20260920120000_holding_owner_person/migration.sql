-- ADR-0058 D2 — per-holding owner.
--
-- One nullable, additive column on Holding. NULL is the correct historical
-- state for every existing row ("same as account"): nothing here changes any
-- balance, valuation anchor, ledger row or existing ownership column, and RLS
-- on Holding is untouched (the column adds no policy surface).

ALTER TABLE "Holding" ADD COLUMN "ownerPersonId" TEXT;

CREATE INDEX "Holding_ownerPersonId_idx" ON "Holding"("ownerPersonId");

-- Tenant-safe composite FK (Pattern A, ADR-0010) — a holding can never be
-- owned by another family's person even if an id is forged. MATCH SIMPLE, so
-- a NULL owner is not checked.
--
-- Column-scoped `SET NULL ("ownerPersonId")` (PG 15+, this project runs 16) is
-- REQUIRED, not the bare `SET NULL` Prisma's schema DSL would emit: a
-- composite FK's plain `SET NULL` nulls EVERY referencing column, including
-- `familyId` — which is NOT NULL on Holding — and deleting the person would
-- fail outright (same reason as `account_zakat_payer_fkey`, ADR-0056).
-- Deleting a person un-owns the holding; it never touches ledger data.
ALTER TABLE "Holding" ADD CONSTRAINT "holding_owner_person_fkey"
  FOREIGN KEY ("ownerPersonId", "familyId") REFERENCES "ZakatPayer"("id", "familyId")
  ON DELETE SET NULL ("ownerPersonId") ON UPDATE CASCADE;

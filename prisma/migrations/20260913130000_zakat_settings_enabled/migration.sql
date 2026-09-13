-- ADR-0056 fast-follow — Zakat is opt-in, off by default.
--
-- Slice 1 shipped with no on/off switch: `computeZakatFn` silently used
-- `DEFAULT_ZAKAT_SETTINGS` for any family that had never opened Zakat
-- settings, and the feature was only reachable by typing `/zakat` directly
-- in the URL bar. Not every Permoney user is Muslim, so this must be an
-- explicit choice, off by default. Purely additive: every existing
-- `ZakatSettings` row (and the implicit "no row yet" default) becomes
-- `enabled = false`, matching the historical reality that nobody had ever
-- turned this on through a real toggle.

ALTER TABLE "ZakatSettings" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false;

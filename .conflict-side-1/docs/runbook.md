# Runbook

## Idempotency Record Cleanup

ADR-0006 gives `IdempotencyRecord` rows a 24-hour replay window. Until Permoney
has a scheduled job runner, operators can purge expired replay-cache rows with:

```sql
DELETE FROM "IdempotencyRecord"
WHERE "expiresAt" < now();
```

This cleanup must not delete `Transaction` rows. Transaction-level
`idempotencyKey` values are retained on the canonical ledger row as immutable
financial evidence.

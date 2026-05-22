## Summary

-

## Testing

- [ ] `vp check`
- [ ] `vp run test:unit:coverage`
- [ ] `vp run test:integration`
- [ ] `vp run test:e2e`
- [ ] `vp build`

## Critical Finance Impact

- [ ] This PR does not touch ledger mutation, balance updates, RLS, idempotency, audit logging, or auth guards.
- [ ] This PR touches a critical finance/auth path and includes deterministic tests in the relevant suite.
- [ ] Existing tests already cover this change.

If existing tests cover the change, name them and state the invariant they prove:

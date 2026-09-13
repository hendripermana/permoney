# Suggested Commands

- Install/generate client/hooks: `vp install`.
- Dev server: `vp dev` (project default port 3006) or custom package script `vp run dev`.
- Production: `vp build`, `vp preview`.
- Quality: `vp check`, `vp lint`, `vp fmt`, `vp test`.
- Unit once: `vp test run`; integration: `vp run test:integration`; browser E2E: `vp run test:e2e`; coverage: `vp run test:unit:coverage`.
- Database: `vp run db:up`, `vp run db:migrate`, `vp run db:studio`, `vp run db:down`.
- Dependency/binary operations: `vp add|remove|update|install`, `vp exec`, `vp dlx`.
- Built-in names resolve to Vite+ commands; use `vp run <script>` for package scripts sharing those names.

# Tech Stack

- TypeScript 6, React 19, TanStack Start/Router/Query/DB.
- Prisma 7 with PostgreSQL and `@prisma/adapter-pg`; Better Auth.
- Tailwind CSS 4 + owned shadcn/ui primitives.
- Vite+ is mandatory toolchain entrypoint. Current project runtime: `vp`/vite-plus 0.1.23, Node 24, underlying pnpm 10.32.1.
- Vite+ wraps Vite/Rolldown, Vitest, Oxlint, Oxfmt, tsdown. Imports use `vite-plus` and `vite-plus/test`, not direct Vite/Vitest dependencies.
- Package operations must use `vp`; do not invoke npm/pnpm/yarn directly.

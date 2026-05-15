#!/usr/bin/env node

console.log(`
============================================================
              PERMONEY DEV SMOKE CHECK
============================================================

To verify the development runtime is stable, perform these steps:

1. Start local Postgres services:
   docker compose up -d postgres

2. Run the dev server:
   vp dev

3. Open a browser and navigate to:
   http://localhost:3000/login

4. Complete or bypass onboarding:
   - If not signed up, sign up.
   - Or use seed data credentials.

5. Navigate to the Ledger/Transactions page:
   http://localhost:3000/transactions

6. VERIFY:
   - The page renders successfully.
   - Open Browser Developer Tools (Console).
   - There MUST NOT be any 'module export mismatch' or 'react-dom/server.browser.js' errors.
   - The UI should not crash.

If all steps pass, the M1.5 dev runtime stability gate is cleared.
============================================================
`)

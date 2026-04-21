---
name: verify
description: Run full verification suite (type-check, lint, test) before marking work done
---

Run the following checks in sequence. Stop at the first failure and fix the issue before continuing.

1. **Type-check:**

   ```bash
   npx tsc --noEmit
   ```

2. **Lint:**

   ```bash
   npx eslint .
   ```

3. **Test:**
   ```bash
   npx vitest run
   ```

If all three pass, report success. If any fail, fix the issues and re-run the failing step before proceeding to the next.

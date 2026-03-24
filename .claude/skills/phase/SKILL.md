---
name: phase
description: Show current implementation phase details and verification steps from PLAN.md. Use /phase or /phase <number> to view a specific phase.
---

Read @PLAN.md and find the implementation phases section.

If `$ARGUMENTS` is provided (e.g., `/phase R3`), show details for that specific phase. Otherwise, determine the current refactoring phase by checking which phases are already implemented:

1. Check if `src/main/pty-manager.ts` exists → Phase R1 done
2. Check if `src/renderer/components/Terminal.tsx` AND `src/renderer/components/DetailPane.tsx` exist → Phase R2 done
3. Check if session-manager.ts no longer references `ghostty` (grep for "ghostty" in session-manager) → Phase R3 done
4. Check if `src/main/window-capture.ts` has been deleted AND thumbnails come from renderer → Phase R4 done
5. Check if pty-manager has `discoverSessions` that calls `tmux list-sessions` → Phase R5 done
6. Check if `src/main/window-focus.ts` has been deleted → Phase R6 done

Report the next unimplemented phase. Show:

- The phase name and number
- The full **Input**, **Do**, and **Verify** sections from PLAN.md
- A summary of what files will be created or modified

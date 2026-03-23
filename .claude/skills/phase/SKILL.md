---
name: phase
description: Show current implementation phase details and verification steps from PLAN.md. Use /phase or /phase <number> to view a specific phase.
---

Read @PLAN.md and find the implementation phases section.

If `$ARGUMENTS` is provided (e.g., `/phase 3`), show details for that specific phase number. Otherwise, determine the current phase by checking which phases are already implemented:

1. Check if `package.json` exists → Phase 1 done
2. Check if the app shell layout exists (dark theme CSS, sidebar+canvas+statusbar) → Phase 2 done
3. Check if `src/main/project-scanner.ts` exists → Phase 3 done
4. Check if `src/renderer/components/ProjectTree.tsx` exists → Phase 4 done
5. Check if `src/main/hook-installer.ts` exists → Phase 5 done
6. Check if `src/main/hook-server.ts` exists → Phase 6 done
7. Check if `src/main/session-manager.ts` exists → Phase 7 done
8. Check if `src/renderer/components/SessionCard.tsx` exists → Phase 8 done
9. Check if `src/main/window-capture.ts` exists → Phase 9 done
10. Check for zoom/pan logic in SessionCanvas → Phase 10 done
11. Check for cluster layout logic → Phase 11 done
12. Check for edge indicators logic → Phase 12 done
13. Check for worktree cleanup dialog → Phase 13 done
14. Check for tray icon code → Phase 14 done
15. Check for keyboard shortcuts + persistence polish → Phase 15 done

Report the next unimplemented phase. Show:
- The phase name and number
- The full **Input**, **Do**, and **Verify** sections from PLAN.md
- A summary of what files will be created or modified

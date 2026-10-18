# GitHub Flow

- Start each task on a named branch and isolated worktree from current `main`.
- Preserve concurrent work. Never reset, stash, overwrite or stage unrelated changes.
- Make scoped, coherent commits. Run focused tests and obtain an independent review before integration.
- Before release, integrate current `main` and the current live release revision. Resolve both intents and test the integrated commit, not an older feature snapshot.
- One parent owns integration and release. Subagents implement and report; they never deploy or restart services.
- Merge and deploy only with explicit permission. Release the exact reviewed, tested commit and verify the deployed revision.

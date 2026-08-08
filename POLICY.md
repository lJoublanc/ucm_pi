# Unison Codebase & Commit Policy

This document defines the policy for managing Unison code modifications, scratch files, and codebase commits when using the Unison tools and skills.

## Commit & Persistence Policy

- **Scratch Files vs. Codebase Commits**:
  - Preparing changes in a `*.u` scratch file keeps edits in working memory/disk files for typechecking without modifying the Unison codebase history.
  - Committing via `unison_update` (or UCM `add`/`update`) persists changes directly into the content-addressed codebase history.

- **Default Workflow & Persistence**:
  - By default, changes should be prepared in a `*.u` scratch file and typechecked.
  - Do not automatically commit changes (`unison_update`, `add`, `update`) to the codebase unless requested or intended for the task.
  - Verbs like *replace*, *edit*, or *fix* mean preparing the change in a scratch file unless explicit persistence is requested.
  - Do not commit "to be helpful", to run a test, or to tidy up unless directed or expected.

- **Handling Uncertainty**:
  - **If the agent is unsure whether to keep changes in a scratch file or commit them to the codebase (or how to proceed), the agent should ask the user what to do, if not explicitly told.**

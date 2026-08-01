# Change Log

All notable changes to the "learning-copilot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Exercise state (tasks, solutions, hints, completion, answer keys, design
  analyses) now lives in a `.learning-copilot/` folder inside the project
  instead of VS Code's per-workspace and global storage, so copying, renaming
  or moving a generated project keeps it fully working. Existing projects
  migrate automatically the next time they are opened.
- Task links in `LEARNING_EXERCISES.md` are workspace-relative. They were
  absolute, so a link clicked in a copied project opened the original folder's
  file. Existing exercises files are repaired on open.
- Solution snapshots now merge across runs, so Compare With Solution keeps
  working for files scaffolded by an earlier run.

- Initial release
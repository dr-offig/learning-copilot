# Learning Copilot

Learning Copilot is a VS Code extension that uses GitHub Copilot to:

- generate or modify real project files from a prompt
- automatically convert those solutions into a guided learning scaffold
- create `LEARNING_EXERCISES.md` plus an instructor-only answer key
- let learners reveal hints or apply solutions for individual tasks

It talks to Copilot through the VS Code Language Model API when the GitHub
Copilot Chat extension is installed and signed in, and falls back to the
GitHub Copilot CLI otherwise (the extension can install the CLI for you,
without admin rights).

## What It Does

After code generation/modification, the extension scaffolds the result:

- the model nominates verbatim code snippets worth turning into exercises
- the extension locates each snippet and inserts task markers
  (`__LC_TASK_<id>_START__/END__`) itself, using the correct comment syntax
  for each file type — so marker formatting can't be wrong
- solution mappings are saved per task id
- learner instructions are written to `LEARNING_EXERCISES.md`
- private artifacts (full solution snapshots + answer keys) are saved in
  extension storage

It also supports:

- side-by-side compare of current file vs saved solution snapshot
- revealing/applied blank solutions at cursor or next blank
- marking blanks done while keeping your own implementation

## Requirements

- VS Code `^1.109.0`
- A GitHub account with Copilot entitlement (the free student plan works)
- Either the GitHub Copilot Chat extension (preferred), or GitHub Copilot CLI
  access (the extension can install the CLI for you)
- Open a workspace/folder before running commands

## Quick Start

1. Open a project folder in VS Code.
2. Run `Learning Copilot: Install/Setup Copilot CLI`.
3. Run `Learning Copilot: Generate Code Files from Prompt` (new project) or `Learning Copilot: Modify Workspace From Prompt` (existing project).
4. Preview and approve file writes.
5. Choose `Generate` when prompted to build the learning scaffold.
6. Work through blanks and exercises, then use blank commands as needed.

When authentication is missing, the extension prompts you to log in and opens a terminal flow for Copilot CLI login.

## Commands

- `Learning Copilot: Install/Setup Copilot CLI`
- `Learning Copilot: Generate Code Files from Prompt`
- `Learning Copilot: Modify Workspace From Prompt`
- `Learning Copilot: Compare Active File With Solution`
- `Learning Copilot: Apply Solution For Blank At Cursor`
- `Learning Copilot: Apply Solution For Next Blank`
- `Learning Copilot: Show Hint For Blank At Cursor`
- `Learning Copilot: Mark Blank As Done At Cursor`
- `Learning Copilot: Open Latest Answer Key`
- `Learning Copilot: Save Last Output`

## Settings

- `learningCopilot.transport` (default: `auto`) — `auto` uses the VS Code
  Language Model API when a Copilot model is available and falls back to the
  Copilot CLI; `languageModelApi` and `copilotCli` force one transport.
- `learningCopilot.modelFamily` (default: empty) — preferred model family for
  the Language Model API; empty picks the Copilot model with the largest
  context window.
- `learningCopilot.copilotPath` (default: `copilot`)
- `learningCopilot.autoInstallCopilotCli` (default: `true`)
- `learningCopilot.copilotArgs` (default: `[]`)

## Output and Storage

- Learner-facing exercises are written to `LEARNING_EXERCISES.md` in your workspace.
- Full solution snapshots and answer keys are stored in extension global storage.
- Compare uses the latest snapshot and currently active file.

## Development

```bash
npm install
npm run compile
```

Useful scripts:

- `npm run watch`
- `npm run lint`
- `npm run check-types`
- `npm test`

To run locally in VS Code:

1. Open this repo.
2. Press `F5` to launch an Extension Development Host.
3. Run commands from the Command Palette.

## Known Limitations

- Requires Copilot CLI availability and authentication.
- Scaffold quality depends on model output and prompt complexity.
- Snapshot/answer-key state is per extension storage, not per git branch.

## License

See `LICENSE` if provided in this repository.

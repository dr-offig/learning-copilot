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

## Design Files and Image Assets

Workspace images play one of two roles:

- **Design documents** — pictures *of* the site (PDF mockups, PNG/JPEG/GIF/WebP
  wireframes). These are analyzed once by a vision-capable model; the
  description is cached (keyed by content hash) so unchanged files are never
  re-analyzed, and written to `LEARNING_DESIGNS.md` so students can read what
  the model saw. Prompts can then reference a design by filename, e.g.
  *"build the site following homepage.pdf"*.
- **Content assets** — pictures *for* the site (photos, logos, icons, plus
  SVG/ICO). These cost no AI calls: the extension reads their pixel
  dimensions locally from the file headers and lists them to the model, which
  is instructed to reference them by their exact relative paths in generated
  code (`<img src>`, CSS `url()`) and never invent image paths that don't
  exist.

Folder conventions decide the role automatically: images under `designs/`,
`mockups/`, or `wireframes/` are design documents; images under `assets/`,
`images/`, `img/`, `public/`, `static/`, `media/`, `photos/`, or `icons/` are
content assets; PDFs are always design documents. Images anywhere else (e.g.
the workspace root) trigger a one-time multi-select question whose answers
are remembered per file.

Run `Learning Copilot: Analyze Design Files` to analyze up front or refresh
after editing a design. PDF analysis uses the Copilot CLI (the VS Code
Language Model API only accepts images); images work on either transport.

## Requirements

- VS Code `^1.109.0`
- A GitHub account with Copilot entitlement (the free student plan works)
- Either the GitHub Copilot Chat extension (preferred), or GitHub Copilot CLI
  access (the extension can install the CLI for you)
- Open a workspace/folder before running commands

## Quick Start

1. Open a project folder in VS Code.
2. Click the `Learning Copilot` button in the status bar (bottom left) to open the menu.
3. Choose `Create or Update Project from Prompt` and describe what to build.
   The extension detects whether your workspace is empty (create a new
   project) or already contains code (update the existing project).
4. Preview and approve file writes.
5. Choose `Generate` when prompted to build the learning scaffold.
6. Work through the tasks in `LEARNING_EXERCISES.md`. Right-click inside a
   task region for hints, marking done, or revealing the solution.

If the GitHub Copilot Chat extension is not available, use the menu's
`Copilot CLI Setup…` entry to install and log in to the Copilot CLI. When
authentication is missing, the extension prompts you to log in and opens a
terminal flow for Copilot CLI login.

## Commands

Everything is reachable from the status bar menu; the same commands are also
in the Command Palette:

- `Learning Copilot: Open Menu`
- `Learning Copilot: Create or Update Project from Prompt`
- `Learning Copilot: Analyze Design Files`
- `Learning Copilot: Open Learning Exercises`
- `Learning Copilot: Compare Active File With Solution`
- `Learning Copilot: Apply Solution For Task At Cursor`
- `Learning Copilot: Apply Solution For Next Task`
- `Learning Copilot: Apply Solution For All Tasks`
- `Learning Copilot: Show Hint For Task At Cursor`
- `Learning Copilot: Mark Task As Done At Cursor`
- `Learning Copilot: Open Latest Answer Key`
- `Learning Copilot: Install/Setup Copilot CLI` (and login/logout/details/set path)

## Keyboard Shortcuts

Default shortcuts (all rebindable via `Preferences: Open Keyboard Shortcuts`,
searching for "Learning Copilot"):

| Shortcut | Command | Available |
| --- | --- | --- |
| `Ctrl+Alt+L` | Open Menu | always |
| `Ctrl+Alt+X` | Open Learning Exercises | always |
| `Ctrl+Alt+H` | Show Hint For Task At Cursor | cursor inside a task |
| `Ctrl+Alt+M` | Mark Task As Done At Cursor | cursor inside a task |
| `Ctrl+Alt+A` | Apply Solution For Task At Cursor | cursor inside a task |
| `Ctrl+Alt+N` | Apply Solution For Next Task | editor focused |
| `Ctrl+Alt+S` | Compare Active File With Solution | editor focused |

The same `Ctrl+Alt` combinations are used on macOS (Control+Option), so the
shortcuts are identical on lab machines and personal laptops. The letters are
chosen to avoid the `Ctrl+Alt` hotkeys claimed globally by common macOS window
managers (Magnet, Rectangle, Spectacle): C, D, E, F, G, R, T, U, I, J, K,
arrows, and Return.

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

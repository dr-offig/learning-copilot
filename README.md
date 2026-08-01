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
- task state, full solution snapshots and answer keys are saved in a
  `.learning-copilot/` folder inside the project

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

## Figma Variables

`Learning Copilot: Import Figma Tokens` turns a Figma file's design system into
CSS custom properties. It reads the real token graph through the Figma MCP
server — collections, named modes and alias references all intact — rather than
the flattened, selection-scoped view a chat prompt would get.

The output follows the two-layer convention:

- **Primitive tokens** (collections whose values are all fixed) become literals:
  `--primitive-color-purple-700: #797596`.
- **Semantic tokens** (collections that alias other tokens) become references:
  `--color-primary: var(--primitive-color-purple-700)`.
- **Modes** other than the default become overrides. Light and Dark map to
  `prefers-color-scheme` automatically; for anything else you are asked once
  whether the mode is a breakpoint, a colour scheme, or switched by a
  `data-mode` attribute, and the answer is remembered. The import also reads
  your top-level artboard sizes, so a `Tablet` mode offers `max-width: 768px`
  when that is how wide the Tablet frame is — the breakpoint comes from the
  design rather than from a guess.

Which mode is the *default* — the one whose values sit in `:root` — cannot be
guessed, since Figma's mode ordering is arbitrary. You are asked once per
multi-mode collection.

The first time you import, VS Code asks permission to run the extractor in
Figma and shows you the whole script. That is expected — the script explains
itself in a header comment, including why it deliberately finishes by throwing
an error (Figma discards return values, so the results come back as error
text). Nothing in your design is modified. To stop being asked every time, use
`Chat: Manage Tool Approval` from the Command Palette and trust the Figma
server's `use_figma` tool; avoid the blanket `chat.tools.autoApprove` setting,
which approves everything else too. VS Code also starts the Figma MCP server on
demand, so it does not need to be running beforehand.

The conversion is a deterministic transform, not a prompt, so nothing is
dropped or renamed in transit and the numbers can be checked: the emitted
counts are cross-checked against the extractor's own. Tokens that cannot be
converted are reported rather than skipped in silence — dangling aliases, alias
loops (which would render the page unstyled with no browser error), and values
that would break out of the stylesheet.

**Importing is the metered step.** Figma counts MCP reads against the plan of
the team that owns the file, not against your seat, so a file in your Drafts
gets the Starter allowance of six calls a month even on a paid plan. The
imported report is therefore cached in `.learning-copilot/figma-tokens.json`,
and regenerating the stylesheet from it is free — only an explicit re-import
contacts Figma. Sharing that JSON file with someone lets them generate the same
CSS without a Figma account at all.

## Requirements

- VS Code `^1.109.0`
- A GitHub account with Copilot entitlement (the free student plan works)
- Either the GitHub Copilot Chat extension (preferred), or GitHub Copilot CLI
  access (the extension can install the CLI for you)
- Open a workspace/folder before running commands
- For Import Figma Tokens only: the Figma MCP server configured in VS Code and
  signed in, plus access to the file you are importing. Link sharing is not
  enough — Figma checks account permission, so work from your own copy of the
  design (File → Duplicate to your drafts).

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
- `Learning Copilot: Import Figma Tokens`
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
- `learningCopilot.figmaTokensPath` (default: `tokens.css`) — where the
  stylesheet generated from Figma variables is written.

## Output and Storage

- Learner-facing exercises are written to `LEARNING_EXERCISES.md` in your workspace.
- Everything else lives in a `.learning-copilot/` folder in the same project:
  - `state.json` — task solutions, hints, completion state, design analyses
  - `solutions/` — full solution copies of every scaffolded file
  - `answer-keys/` — the five most recent answer keys
  - `figma-tokens.json` — the last imported Figma token report
- CSS generated from Figma variables goes to `tokens.css` (see
  `learningCopilot.figmaTokensPath`).
- Compare uses the solution snapshot and currently active file.

Keeping state in the project means an exercise folder can be copied, renamed,
moved, or zipped up and handed to someone else, and everything still works —
task links, hints, Apply Task, Compare With Solution and the answer key. The
trade is that the solutions are readable by a determined student; Compare With
Solution and Open Latest Answer Key already put them a menu item away.

`.learning-copilot/` is deliberately *not* added to `.gitignore`, so a project
distributed by git carries its exercise state too. Add it yourself if you'd
rather students committed only their own work.

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
- Snapshot/answer-key state is per project folder, not per git branch.

## License

See `LICENSE` if provided in this repository.

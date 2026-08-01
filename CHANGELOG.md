# Change Log

All notable changes to the "learning-copilot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.7]

- New **Import Figma Tokens** command and menu item. It reads a Figma file's
  variable collections, modes, aliases and text styles, and writes them out as
  CSS custom properties: primitive tokens as fixed values, semantic tokens as
  `var()` references to those primitives, and every non-default mode as an
  override. Modes named Light and Dark become `prefers-color-scheme` queries;
  for anything else — breakpoints, brands, themes — you are asked once how the
  mode should apply, and the answer is remembered.
- New **Import Figma Page Structure** command. It reads the layout of an
  artboard straight out of Figma — nesting, auto-layout direction, spacing,
  padding, alignment, the real text, and which design token is bound to each
  colour, gap and font size — and writes it to `FIGMA_DESIGN.md`. Prompts then
  use that as the design guide, so a site can be generated from the design
  without analysing a single screenshot and without spending AI credits on
  describing one. It is exact where an image analysis can only estimate:
  layer names, spacing values and token references all come from the file
  itself.
- **Analyze Design Files** now asks which files to analyse when there is more
  than one, with un-analysed files pre-selected. Analysing is the only part
  that costs an AI call, so it should be a choice. (Image *assets* never cost
  a call — their dimensions are read locally — and are unaffected.)
- Breakpoints are suggested from the design rather than guessed. The import
  also reads the top-level artboard sizes, so a `Tablet` mode offers
  `max-width: 768px` because that is how wide the Tablet frame actually is.
- The conversion is a plain deterministic transform rather than a prompt, so
  nothing is dropped or renamed on the way through. Tokens that cannot be
  converted are reported instead of being silently skipped: dangling aliases,
  alias loops, and values that would break out of the stylesheet.
- Imported tokens are cached in `.learning-copilot/figma-tokens.json`.
  Regenerating the stylesheet uses the cache and costs nothing; only an
  explicit re-import contacts Figma. This matters because Figma meters MCP
  reads against the plan of the team owning the file, and a file in a
  student's Drafts is allowed six a month.
- New `learningCopilot.figmaTokensPath` setting for where the generated
  stylesheet goes (default `tokens.css`).
- Requires the Figma MCP server to be configured in VS Code and signed in.
  Learning Copilot calls it directly, so importing tokens never sends you to
  Copilot Chat and never spends a Copilot request.
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

## [0.0.1]

- Initial release
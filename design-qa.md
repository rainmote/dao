# TUI visual parity QA

## Comparison target

- Source visual truth: `/Users/one/study/qwen-code/docs/design/ctrl-o-detail-expand/assets/main-view-collapsed.png`
- Current Qwen component truth: `/Users/one/study/qwen-code/packages/cli/src/ui/components/`
- Implementation capture: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-history-160x44.png`
- Dialog-state capture: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-model-dialog-160x44.png`
- Combined comparison: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/history-comparison.png`
- Theme captures: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-theme-qwen-dark-160x44.png` and `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-theme-dracula-160x44.png`
- Theme selector capture: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/bb-agent-theme-dialog-160x44.png`
- Theme comparison: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/theme-comparison.png`
- Theme preview comparison: `/Users/one/workspace/dao/docs/design/tui-visual-parity/assets/theme-preview-comparison.png`

## Capture normalization

- Source pixels: 1400 × 900.
- Implementation pixels: 1385 × 876 from a 160 × 44-cell xterm viewport, Menlo 14 px, line-height 1.2, device scale factor 1.
- Full-view comparison: both images normalized to 700 × 450 CSS pixels in one 1440 × 486 comparison image.
- State: the source is an active, tool-rich session; the implementation is a completed offline mock turn. Dynamic content density is intentionally different. Only shared shell, hierarchy, typography, tokens, and controls were judged across these two states.
- Focused evidence: the native-resolution source and implementation images were also inspected directly for the header/banner and composer/footer regions. No extra crop was needed because both regions remain legible at native resolution. The dialog capture separately verifies that the dialog replaces composer/footer while preserving history.

## Findings

No actionable P0, P1, or P2 differences remain in the shared visual surfaces.

- Fonts and typography: both captures use a 14 px Menlo-class monospace face. Heading, secondary text, input, user, assistant, and status weights preserve the same hierarchy.
- Spacing and layout rhythm: the two-column 37-column wordmark plus single-border runtime panel, two-column breakpoint, two-column margins, scrolling banner, full-width input rules, and two-column footer behavior follow the Qwen layout. The 80-column PTY check hides the wordmark without clipping the panel.
- Colors and tokens: the implementation uses Qwen's default dark semantic mapping and blue-purple-pink gradient. Focus, accent, secondary, success, warning, and error colors no longer use component-local color names. Theme-specific syntax/diff colors retain Qwen's raw built-in palettes.
- Image and asset fidelity: this terminal surface has no raster image assets. The source's native ASCII wordmark treatment is retained with a project-specific `BB AGENT` wordmark of equivalent width and gradient behavior.
- Copy and content: Qwen's placeholder, Tips line, model-change hint, dialog help, and busy/abort affordances are preserved. Product identity and mock response text intentionally remain bb-agent-specific.
- Icons: user, assistant, reasoning, and tool status glyphs follow the Qwen vocabulary (`>`, `◆`, `∵`, `∴`, `o`, `⊷`, `✓`, `x`) and force ambiguous symbols to text presentation where needed.
- States and interactions: idle, completed history, model dialog, theme preview/apply/rollback, narrow terminal, selection, approval, input, loading, queue, and long-history states are covered by captures or component tests. Opening a dialog hides composer/footer and keeps the conversation visible.
- Accessibility and resilience: all controls remain keyboard-driven; software cursor and focus border are visible; grapheme editing and constrained-height dialogs are covered. The 80-column PTY capture and narrow component tests show no overlap or clipping.

## Comparison history

### Iteration 1

- Earlier finding: the first implementation used a compact 17-column `BB` mark and the optional gold/orange Qwen Dark palette. Against the source, this left the header visually underweighted and used the wrong default gradient.
- Fix: replaced it with a 37-column `BB AGENT` wordmark and mapped every component to Qwen's default dark semantic tokens and blue-purple-pink gradient.
- Post-fix evidence: `history-comparison.png` and `bb-agent-history-160x44.png`.

### Iteration 2

- Earlier finding: the initial xterm capture did not anchor to the live bottom, making the dialog screenshot appear to lose history even though the Ink frame retained it.
- Fix: matched Qwen's terminal-capture behavior by scrolling xterm to the live bottom before each screenshot; also added an App regression assertion that banner/history remain while composer/footer disappear.
- Post-fix evidence: `bb-agent-model-dialog-160x44.png`.

### Iteration 3

- P1 finding: `/theme` updated only a local `midnight|paper|matrix` label while every component retained the module-load palette, so changing the theme produced no visual change. The host also kept its initial theme and could overwrite the frontend on a later extension snapshot.
- Fix: replaced the placeholder list with Qwen Code's current built-in registry and `Qwen Dark` default; removed the legacy `midnight|paper|matrix` aliases; moved semantic colors behind live getters; made list highlight preview immediately, `Esc` restore the previous selection, and `Enter` update both frontend and host. Tool status colors and fenced-code colors now resolve at render time instead of being captured during import.
- Post-fix evidence: `theme-comparison.png` shows the same 160 × 44 idle state before and after `/theme Dracula`; the wordmark, title, focused input rule, prompt, and status tokens visibly switch together.
- Strictness check: `bb-agent-theme-dialog-160x44.png` contains only Qwen Code theme names. `/theme midnight`, `/theme paper`, and `/theme matrix` are rejected locally and never mutate host theme state.

### Iteration 4

- P1 finding: runtime theme selection and host synchronization were working, but the generic list-only selector hid an important Qwen behavior. `Qwen Dark`, `Default`, and `ANSI` intentionally share the default dark semantic chrome, so an idle screen can look almost unchanged even though their syntax palettes differ. The missing Qwen code/diff preview made those real differences impossible to inspect before applying a theme.
- Fix: theme selection now uses a dedicated Qwen-style 45%/55% dialog. The left pane keeps the numbered, scrolling theme list; the right pane renders the highlighted theme's foreground, background, syntax colors, and semantic add/remove diff colors immediately. Wide terminals get the full preview, constrained heights reduce preview detail, and narrow terminals retain a list-only layout. `Esc` rollback and `Enter` host application remain unchanged.
- Post-fix evidence: `theme-preview-comparison.png` shows the same 160 × 44 dialog with Qwen Dark and Qwen Light highlighted. The code surface changes from dark to light and syntax/diff colors remain readable in both. `theme-comparison.png` separately confirms that applying Dracula still updates the main shell.
- Regression result: 71 TUI tests, the full TypeScript/web test suite, and 58 Clojure tests with 430 assertions pass.

## Follow-up polish

- P3: the checked-in Qwen source screenshot is from v0.19.2 and contains different session content. Current component source was used to resolve later token and layout behavior, but an upstream current-version idle screenshot would make future pixel diffs more exact.
- Expected difference: the wordmark, product title, version, provider, model, path, and transcript content remain specific to bb-agent.

## Implementation checklist

- [x] Default Qwen semantic tokens and gradient.
- [x] Runtime Qwen theme registry, two-pane code/diff preview, cancel rollback, and host synchronization.
- [x] Responsive scrolling banner and runtime panel.
- [x] Qwen message, reasoning, Markdown, and tool hierarchy.
- [x] Horizontal-rule composer, placeholder, software cursor, loading, queue, and footer.
- [x] Dialog-exclusive controls with preserved history.
- [x] Wide and narrow terminal validation.
- [x] Full component and transport regression suite.

final result: passed

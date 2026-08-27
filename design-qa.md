# Script-Loader settings design QA

**Comparison target**

- Source visual truth: `F:\Codex\Codex++ ui plugin\codex-script-loader\.runtime\qa-installed\01-native-after.png`
- Loader implementation: `F:\Codex\Codex++ ui plugin\codex-script-loader\.runtime\qa-installed\02-loader-after.png`
- Bennett implementation: `F:\Codex\Codex++ ui plugin\codex-script-loader\.runtime\qa-installed\03-bennett-after.png`
- Full-view comparison evidence:
  - `F:\Codex\Codex++ ui plugin\codex-script-loader\.runtime\qa-installed\04-native-vs-loader-after.png`
  - `F:\Codex\Codex++ ui plugin\codex-script-loader\.runtime\qa-installed\05-native-vs-bennett-after.png`
- Viewport: 1513 × 903 CSS px, light theme, Chinese locale
- Source and implementation pixels: 3026 × 1806 px each
- Device scale factor: 2
- Density normalization: none required; every capture used the same CSS viewport and device scale factor
- State: Codex Settings with the native General page, Script-Loader Settings page, and Bennett UI Improvements page captured from the same running renderer

**Findings**

- No actionable P0, P1, or P2 visual mismatches remain.
- The Loader and Bennett pages now use the native `p-panel` scroll surface and the same 768 CSS px content column, 24 px/400 page title, 40 px section rhythm, 14 px/500 section title, 20 px card radius, native border token, and 12 × 16 px row padding measured from the current Codex General settings page.
- The Loader plugin row is intentionally denser than a native preference row because it contains plugin identity, state, version, actions, and a lifecycle switch. It remains inside the native card and control system and does not alter the page scale.

**Required fidelity surfaces**

- Fonts and typography: passed. Page headings are 24 px/400; section headings and row titles use the same native classes, weights, line heights, wrapping behavior, and system font stack as the source page.
- Spacing and layout rhythm: passed. Heading origin is identical at x=522.664 and y=148; page width is 768 CSS px; section gap, card radius, border, row padding, and scrollbar placement match the source.
- Colors and visual tokens: passed. The implementation reuses Codex foreground, tertiary, border, hover, and semantic status tokens rather than introducing an independent palette.
- Image quality and asset fidelity: passed as not applicable. These settings pages contain no custom raster illustrations, logos, or replacement SVG art; visible controls reuse Codex-native styling.
- Copy and content: passed. The Loader page presents status, plugin management, restart, and diagnostics in concise Chinese; Bennett settings preserve the plugin-defined labels and descriptions.
- Accessibility: semantic `h1`, button, label, and switch controls remain present. Focus styles use the Codex token classes. A full keyboard-only traversal and high-contrast mode pass were not part of this visual comparison and remain a non-blocking test gap.
- Responsiveness: the implementation retains the native `max-w-3xl` and `electron:min-w[...]` constraints. This pass covers the current 1513 × 903 desktop viewport; narrower-window visual QA remains a non-blocking test gap.

**Focused region comparison evidence**

- A separate crop was not necessary. The two combined 4096 px-wide comparison boards preserve the full 2× screenshots at a readable scale, and DOM measurements independently confirm the important small surfaces: title typography, section title typography, card borders/radii, row padding, button sizing, switch sizing, and scroll-container geometry.

**States and interactions checked**

- Navigated between native General, Script-Loader Settings, and Bennett settings, then returned to Script-Loader Settings.
- Confirmed the pre-release Loader host remained mounted at lifecycle version `0.3.4`, Bennett remained `running` at `1.4.9`, and the exact renderer URL remained `app://-/index.html`. Release metadata is now frozen at Loader `0.4.2` and Bennett `1.4.10`.
- Confirmed one Loader navigation group, one panel host, and one page shell in the active Loader state.
- Add, remove, enable/disable, reload, and restart actions were not invoked during visual QA because they mutate plugin or application state; their implementation contracts are covered by the automated test suite.

**Comparison history**

1. Initial comparison found actionable P2 density drift: Loader and Bennett bypassed the native scroll surface, used custom 108 px top spacing, 14 px card radii, 16 px/600 section headings, and 15 × 20 px rows. The pages therefore appeared enlarged relative to Codex settings.
2. The settings host was changed to mount inside the native `p-panel` and reuse the source page/header/section/card/row classes. Bennett markup and CSS were changed to the same native structure, then its canonical source was synchronized to the bundled and installed copies.
3. Post-fix captures at the identical viewport show aligned title position, content width, scrollbar, card geometry, typography, and row rhythm. Runtime measurements and the combined comparison boards show no remaining P0/P1/P2 difference.

**Implementation checklist**

- [x] Reuse the native settings scroll surface and content column.
- [x] Match native typography, section rhythm, cards, rows, buttons, and switches.
- [x] Preserve plugin-defined settings content and lifecycle controls.
- [x] Capture same-state source and implementation screenshots.
- [x] Compare native/Loader and native/Bennett in combined visual boards.
- [x] Verify runtime lifecycle and duplicate-host counts after hot reload.

**Follow-up polish**

- Optional P3: repeat the capture at a narrow desktop window and in Windows high-contrast mode before a public release.

final result: passed

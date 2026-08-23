# Settings redesign QA

## Comparison target

- Source visual truth: `.runtime/qa-after/final-product-design-native-settings.png`
- Loader implementation: `.runtime/qa-after/final-product-design-loader-settings.png`
- Bennett implementation: `.runtime/qa-after/final-product-design-bennett-settings.png`
- Full-view comparisons:
  - `.runtime/qa-after/final-design-qa-native-vs-loader.png`
  - `.runtime/qa-after/final-design-qa-native-vs-bennett.png`
- State: Codex settings, light theme, Chinese locale; Loader connected; Bennett switches enabled.
- Pixel dimensions: every source and implementation capture is 3026 × 1806 px.
- CSS viewport: 1513 × 903 CSS px at device scale factor 2.
- Density normalization: none required; source and implementations were captured from the same renderer, viewport, theme and scale.

## Findings

No actionable P0, P1 or P2 visual differences remain.

- Typography: page headings use the native 24 px / 28.8 px treatment. Section headings, row titles and descriptions use 16 px, 14 px and 13 px respectively, with the same weight hierarchy as Codex settings.
- Spacing and layout: all pages use the same 768 CSS px content width. Cards use 14 px radii, 76 px minimum rows, 15 × 20 px row padding and 36 px section rhythm. Loader actions now appear before low-frequency diagnostics.
- Colors and tokens: backgrounds, borders, secondary text, hover states and switches use Codex theme tokens. No fixed light-theme panel colors were introduced.
- Image and asset fidelity: these settings pages contain no custom raster imagery. Existing Codex and plugin navigation icons were preserved.
- Copy and content: Loader content is grouped into Overview, Script actions and Diagnostics. Bennett content is grouped into Usage, Codex UI, Sidebar and projects, and Editing and chats. Internal endpoint, bridge and renderer terminology was removed from user-facing descriptions.
- Interaction and accessibility: Reload retains disabled, busy, success and error states with a polite live region. Bennett controls retain switch roles, labels and checked state. Reload, navigation and one Bennett switch were exercised successfully.

Focused image regions were not required: both source and implementation were captured at the same density, and the combined full-view images keep headings, rows, controls and descriptions legible. Computed layout metrics were also checked directly in the renderer.

## Comparison history

1. Initial audit found a P2 hierarchy issue: Loader mixed everyday status with diagnostics in one long card, pushing Reload below the primary content. Bennett mixed quota, layout and settings-page controls in one section and exposed internal implementation terms.
   - Fix: reordered Loader into Overview → Script actions → Diagnostics; split Bennett into four task-oriented groups; rewrote labels and descriptions in plain user-facing language.
   - Evidence: `after-layout-redesign-loader-settings.png` and `after-layout-redesign-bennett-settings.png`.
2. Continuous reload QA found a P1 duplication issue: a stale settings navigation group could survive a host replacement.
   - Fix: settings-host 0.3.2 now removes stale Loader-owned groups during synchronization and shutdown, enforcing one mounted navigation group.
   - Post-fix evidence: the final live run reports one settings group, one Loader entry, one plugin entry and one panel after two reloads.
3. Native-feature audit found that current Codex builds now provide settings search and a shared dynamic sidebar-width token.
   - Fix: Bennett 1.4.5 keeps both former tweaks removed and returns Markdown tables, links, wrapping, and column sizing to Codex's native preview.
   - Post-fix evidence: `v1-4-4-native-cleanup-native-settings.png` and `v1-4-4-native-cleanup-bennett-settings.png`; two reloads report zero legacy search or width-override artifacts.

## Verification

- Primary interactions tested: open Loader, reload scripts, open Interface enhancements, toggle and restore a Bennett option, reload again, leave settings.
- Console errors checked: no Loader/Bennett runtime exceptions and no unrelated renderer exceptions were recorded.
- Final lifecycle: Bennett UI Improvements 1.4.5, 9 features, `stop()` and `setFeature()` available.
final result: passed

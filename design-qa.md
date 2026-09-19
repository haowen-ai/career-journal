# CAREER JOURNAL design QA

## Evidence

- Source visual truth: local-only user-provided reference at `/var/folders/35/xmw2fwbj6zbb9_hlvmv013fh0000gn/T/codex-clipboard-a8965660-48ed-40b3-8949-546a6940b703.png`; excluded from the repository because it contains personal application data
- English implementation screenshot: `docs/assets/dashboard-preview.en.png`; captured from the real local dashboard with a temporary workspace and English synthetic data
- Simplified Chinese implementation screenshot: `docs/assets/dashboard-preview.zh-CN.png`; captured from the real local dashboard with a temporary workspace and Chinese synthetic data
- Full-view comparison: `/tmp/career-journal-design-qa-comparison.png`
- Focused card comparison: `/tmp/career-journal-design-qa-focused.png`
- Browser state: Simplified Chinese, seven synthetic applications, collapsed application cards
- CSS viewport: 1400 × 1210
- Source pixels: 1398 × 1209, normalized to 1400 × 1210 for comparison
- Implementation capture: 1400 × 2754 full-page browser capture, cropped to the same 1400 × 1210 region; effective density 1×

## Findings

- No actionable P0, P1, or P2 differences remain
- Information architecture matches the reference: top brand bar, hero and reminder, five summary cards, search, status filters, full-width application cards, three fact columns, next-step guidance, and expandable history/materials
- Layout rhythm, card proportions, radii, borders, status colors, whitespace, and responsive collapse match the reference closely at the comparison viewport
- Typography preserves the reference hierarchy and uses local system fonts so the app remains offline-capable; platform rendering is slightly denser than the source at small sizes, which is acceptable P3 variation
- CAREER JOURNAL branding, the language control, generic automation copy, and synthetic records are intentional product and privacy changes
- Local Tabler Icons replace text glyphs for the brand, clock, search, language, expand, and collapse controls
- The committed image is a sharp PNG browser capture; no personal names, companies, job identifiers, email addresses, local paths, or credentials appear in it

## Interaction and responsive checks

- Search reduced seven applications to the matching synthetic company
- Search and status filters combined correctly, including a zero-result state
- Closed-status filtering returned both closed synthetic applications after clearing search
- English/Chinese switching updated the page, controls, status labels, and document language, and persisted after reload
- Expanding the Bluefin Vertex Demo record showed two timeline events and one draft material record
- Mobile viewport 390 × 844 rendered all five summaries and seven applications with `scrollWidth === innerWidth`
- Browser console contained no warnings or errors

## Comparison history

- Initial normalized full-view and focused-card comparisons found no P0, P1, or P2 mismatches, so no visual-fix iteration was required

## Follow-up polish

- P3: a future branded typeface could reduce minor platform font-rendering differences if an offline font asset and license are selected

final result: passed

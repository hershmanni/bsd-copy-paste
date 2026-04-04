# Changelog

User-facing release notes reconstructed from manifest history in this repo.

Versions `1.206` and `1.207` do not appear in git history.

## 1.209 - 2026-04-04

- Canvas recency now shows as `Last Graded At` and uses the latest Canvas grading timestamp.
- The sidepanel score table now shows `Graded At`, plus `Attempt` and `Submitted At` when Canvas provides them.
- Empty submission metadata columns now hide automatically for assignments such as paper-only work where Canvas leaves those fields blank.

## 1.208 - 2026-04-02

- Added a sidepanel score table review view for checking Canvas submission data before paste.
- Paste All assignment exclusions now persist instead of resetting.
- Score preview now skips unchanged rows and shows deltas more clearly.
- Score table preview now matches actual paste behavior more closely when rubric data is missing.

## 1.205 - 2026-03-31

- Expanded the Assignment Helper with copy actions for assignment name, assign date, due date, Canvas URL, and a formatted Canvas link.

## 1.204 - 2026-03-09

- Simplified course controls and tightened the mapper card layout in the sidepanel.
- Improved course matching and made mapper cards more compact.
- Added a tutorial link from the sidepanel.
- Added a clearer signed-out state when Canvas authentication expires, including a direct sign-in prompt.

## 1.203 - 2026-03-06

- Redesigned the Assignment Helper for a cleaner sidepanel workflow.
- Hardened mapper persistence so saved mappings survive better across refreshes.

## 1.202 - 2026-03-05

- Improved refresh behavior in the sidepanel.
- Stabilized manual mappings when Synergy columns shift or remap.

## 1.201 - 2026-03-05

- Improved the sidepanel workflow, including refresh, sorting, and fetch progress UX.
- Added stronger per-course and per-section recall so recent Canvas data and mappings come back more reliably.
- Made assignment auto-match and manual alignment persistence more reliable.
- Reduced fetch and paste friction with faster updates, better recency sorting, and improved missing-score handling.

## 1.200 - 2026-02-10

- Major sidepanel release: work can now be done directly in Synergy while authenticated to Canvas.
- Added a Synergy mapping panel with Canvas-to-Synergy assignment matching.
- Added bulk update workflows so multiple assignments can be reviewed and updated more quickly.
- Improved interface guidance and overall reliability for the new sidepanel flow.

## 1.106 - 2024-09-18

- Improved the Missing/Zero option so it is clearer and more reliable on first load.
- Reduced hangs during student fetch and improved paste behavior around cell focus.

## 1.105 - 2024-03-21

- Added a table view of Canvas submissions and paste values in the popup for review before pasting.
- Improved support for spotting missing rubric scores and reviewing which students need a second look.
- Fixed duplicate student rows and improved section-aware student matching.
- Restored the Missing/Zero option screen in the popup.

## 1.104 - 2023-11-08

- Simplified the main popup by moving rounding controls out of the primary workflow.
- Fixed a paste bug so blank rubric scores are no longer treated as zero.

## 1.103 - 2023-08-28

- Refined missing and excused handling during paste.
- Fixed comment-code ordering and removal so pasted status codes stay aligned with Canvas state.
- Removed the overall outcome assignment from the main workflow.

## 1.1021 - 2023-08-16

- Improved how rounding values are displayed.
- Updated late, missing, and excused handling to better match Synergy expectations.

## 1.101 - 2023-04-16

- Added an options link and a visible rounding-level display in the popup.
- Improved rounding display readability.

## 1.10 - 2023-04-16

- Added an options page for saving rounding preferences.
- Added support for a custom round-up threshold instead of always using `0.5`.

## 1.09 - 2023-04-12

- Expanded outcome-score support, including better handling for overall outcomes.
- Added rounding behavior so Canvas outcome scores align better with integer expectations in Synergy.

## 1.08 - 2023-04-09

- Added early support for fetching and working with Canvas outcome scores from Learning Mastery workflows.

## 1.07 - 2023-04-06

- Improved loading visuals in the popup.
- Fixed assignment fetching so rubric-scored assignments are still included even when `use_rubric_for_grading` is not enabled.

## 1.06 - 2023-03-29

- Ordered Canvas assignments by due date and surfaced the most recent items first.

## 1.05 - 2023-03-28

- Restored extension icon assets.

## 1.04 - 2023-03-28

- Initial release of the Canvas-to-Synergy copy/paste extension.

You are editing a FrameWright recording through the GUI.

Return exactly one JSON object. Do not wrap it in Markdown. Do not add prose before or after it.

The JSON contract is the schema below. Treat it as authoritative:

{{outputSchema}}

Rules:

- Prefer `edit.mode: "tasks"` for supported operations. Use `edit.mode: "patch"` only as fallback.
- The only valid task `type` values are:
  `set-range-action`, `trim-pauses`, `set-caption-text`, `set-caption-timing`,
  `add-blur`, `add-annotation`, and `place-material`.
- To change caption text, use exactly
  `{"type":"set-caption-text","target":"@cap_xxxxxx","text":"..."}`.
  Never invent aliases such as `update_caption`.
- To change when a caption is shown (shorten, lengthen, or move it), use exactly
  `{"type":"set-caption-timing","target":"@cap_xxxxxx","startSec":12.3,"endSec":13.1}`.
  `startSec`/`endSec` are source-recording seconds; omit one to keep its current value.
  There is no minimum caption duration. `set-caption-text` never changes timing, so
  a request to shorten a caption's display time must use `set-caption-timing`.
  Changing a caption's timing does not cut video; use `set-range-action` only when
  the user asks to remove footage.
- For `add-annotation`, always send a top-level `range` object with
  `startSec` and `endSec`. Do not put time fields inside `annotation`.
- The only valid annotation `type` values are exactly `arrow`, `box`, and `spotlight`.
  Never use aliases or natural-language labels such as `note`, `label`, `callout`,
  `highlight`, `circle`, or `comment`.
- Annotation geometry is required:
  - `arrow` requires both `from` and `to`, each as `{x, y}` in output pixels.
  - `box` requires `rect` as `{x, y, w, h}` in output pixels.
  - `spotlight` requires `rect` as `{x, y, w, h}` in output pixels.
- Never omit `rect` for `box` or `spotlight`. Never omit `from` or `to` for `arrow`.
- For `edit.mode: "patch"` with `target: "overlays.annotations"`, `value` must be
  the final annotation object itself, including `type`, `start`, and `end`.
  In that final object as well, the only valid `type` values are exactly
  `arrow`, `box`, and `spotlight`.
  Include the required geometry for that type in the same final object.
- Do not use `target: "overlays.annotations"` for `set` edits to an existing annotation.
  For existing annotation item edits, target the stable item id such as `@ann_xxxxxx`.
  Use `target: "overlays.annotations"` only for `add`, or for clearing the whole collection with `remove`.
- Prefer `ops` with stable `@id` targets when possible.
- Use `replace` only when an edit cannot be expressed clearly with `ops`.
- Do not edit `approved` or `approvals.json`.
- Do not edit generated artifacts such as `manifest.json`, `preview.mp4`, `frames/`, or `render.chunks/`.
- For this GUI proposal flow, only propose changes to `cutplan`, `transcript`, `overlays`, or `bgm`.
- Do not propose `chapters` or `thumbnail` changes in this v1 flow.
- Use source-recording seconds for JSON edit times. Output seconds are only review context.
- Keep the patch small and focused on the user's instruction.
- Respect `selectionContext.scope`:
  - `global`: treat the instruction as project-level. Do not assume the current playhead or a selected object is the target, but do use the project projection to choose a best-effort target/timing when the user asks for an edit.
  - `playhead`: focus on the current time and nearby timeline context.
  - `selection`: make the selected object/range/text the primary target, and avoid unrelated edits unless the instruction clearly asks for them.
- Do not refuse merely because the user did not provide an exact timecode. If the projection includes keeps, captions, chapters, or timeline candidates, choose the most relevant available moment and explain the choice in `summary` or `review.notes`.
- For requests like "add an annotation at the best timing", pick a visible kept range or caption midpoint from the projection and add a short-lived annotation there. If the exact on-screen coordinates are not specified, choose conservative visible geometry that can be adjusted in review instead of returning no edit.
- All on-screen coordinates must stay inside the visible output frame.
- Treat `source.video.screenRegion.w` and `source.video.screenRegion.h` as hard bounds for AI-generated geometry.
- Clamp point coordinates so `0 <= x <= width` and `0 <= y <= height`.
- Clamp rectangles so `x >= 0`, `y >= 0`, `w >= 1`, `h >= 1`, `x + w <= width`, and `y + h <= height`.
- Never place materials, captions, blurs, zooms, or annotations outside the visible frame.
{{patchOnlyRules}}

User instruction:

{{instruction}}

Selection context:

{{selectionContext}}

Current project projection:

{{projectJson}}

Bounded local retrieval results (may be empty; these are suggestions only and must not be edited in place):

{{retrievalResults}}

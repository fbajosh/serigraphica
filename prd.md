# Serigraphica Product Requirements

## Purpose

Serigraphica is a desktop tool for correcting photographed serigraphs, posters, prints, and other rectangular paper artwork.

The core product idea is that the user can mark multiple real rectangular structures in the photograph. These rectangles are fixed observed slices of the same physical paper surface. The app uses them to build a smooth dewarp mesh, preview the corrected image, optionally remove clips/shadows with fill masks, and export corrected copies without modifying the source image.

## Current Product Direction

Automated edge detection is not part of the active workflow. The reliable workflow is manual:

1. Open or drag/drop an image.
2. Draw one or more rectangular guide paths.
3. The largest guide is treated as the outer paper boundary.
4. Smaller guides are treated as inner rectangular constraints.
5. Refine guide curves with nodes and symmetric handles.
6. Preview the projected mesh and dewarped output.
7. Draw fill masks on the dewarped preview if clips, clamps, or shadows need removal.
8. Export the corrected image to `output/` or choose a destination with `Export As`.

## Key Principles

- The user-marked rectangles are hard constraints, not loose suggestions.
- Rectangles are classified by geometry, not by draw order or winding direction.
- Inner rectangles are not assumed to be proportional to the outer rectangle.
- The generated mesh must transition smoothly between rectangle constraints; paper can bend, but it should not fold or create crossing mesh lines.
- Fill runs after dewarp so masks are drawn in corrected-output coordinates.
- Source images are never modified.

## Supported Inputs

- JPEG
- PNG

Images can be opened through the File section or dragged onto the empty canvas.

## Guide Paths

### Rectangles

A guide path is a closed rectangular path with:

- Four protected corner nodes.
- Optional side nodes inserted along edges.
- Symmetric Bezier handles on side nodes.
- Sharp corners by default.

The app supports one required outer rectangle plus zero or more inner rectangles. The largest rectangle by area is treated as outer. Smaller rectangles are used as nested constraints.

### Draw Mode

- `Draw` mode starts a new rectangle when the user clicks empty canvas.
- The user clicks four corners to complete the rectangle.
- `Backspace` removes the last point of an incomplete rectangle.
- `Esc` cancels an incomplete rectangle.
- Clicking an existing line inserts a side node.
- Clicking an existing node or handle manipulates that node or handle.
- Completed rectangles are deleted through the list control or `Reset Lines`.

### Pan Mode

- `Pan` mode drags the view.
- Space or `v` switches to pan.
- Cmd+0 fits the image to view.
- Cmd+1 shows actual size.

## Mesh Requirements

The projected mesh must:

- Use all guide rectangles.
- Use the largest rectangle as the outer boundary.
- Use smaller rectangles as hard internal constraints.
- Normalize corners by location, not path winding or click order.
- Preserve orientation; dewarp must not rotate the image unexpectedly.
- Keep mesh lines from crossing or swirling.
- Update live as guide nodes and handles move.
- Default to visible after the first guide is created.
- Hide automatically in dewarp preview, while remaining restorable with `Show Mesh`.

Mesh density is adjustable in the Mesh section. The displayed mesh color defaults to inverse.

## Dewarp Requirements

Dewarp must:

- Require at least two guide rectangles.
- Use the nested rectangle mesh, not a single perspective transform.
- Treat every rectangle edge as a fixed target edge in corrected space.
- Smoothly interpolate between constraints.
- Preserve each rectangle's measured output size instead of forcing proportional outer/inner shapes.
- Report progress as `Dewarping...NN%`.
- Allow cancellation by clicking the dewarping button while work is running.
- Display the preview in the main canvas.
- Toggle back to the original/mesh view when Dewarp is clicked again.

## Fill Requirements

Fill removes clips, clamps, shadows, and similar edge artifacts after dewarp.

Workflow:

1. Dewarp the image.
2. Click `Add` in the Fill section.
3. Draw a four-point polygon around the object to remove.
4. Repeat for additional non-overlapping polygons.
5. Click `Fill`.
6. The fill polygons hide so the cleaned result is visible.
7. `Unfill` removes the fill preview.
8. Editing masks after fill changes the action to `Refill`.

Mask behavior:

- Fill polygons are four-point masks.
- Right-click can remove fill points/shapes during mask editing.
- Fill masks cannot overlap.
- Fill uses dewarped-image coordinates.
- Fill preview writes PNG to avoid JPEG preview artifacts.

Fill algorithm:

- If `models/inpainting_lama_2025jan.onnx` exists, OpenCV DNN runs LaMa ONNX in per-mask crops.
- If the model is missing or fails, the fallback uses sample-texture fill.
- Sample-texture fill uses the clean dewarped paper band between the outer top edge and largest inner top edge as a texture source.
- Copied texture is Lab color-matched to local surrounding paper.
- The user-drawn polygon is fully replaced.
- Feathering expands outward from the drawn polygon; the interior does not fade back to the original artifact.

## Export Requirements

The Export section contains:

- `Export`
- `Export As`

Default export:

- Writes into `output/`.
- Appends `_corrected` to the input filename.
- Uses JPEG output for final corrected images.
- Applies dewarp first.
- Applies fill after dewarp if a fill preview exists or fill masks need refill.

`Export As` opens a save dialog.

## Save Requirements

Guide paths can be saved by filename.

Current behavior:

- Saved paths are stored in localStorage under the image filename.
- Saved paths load automatically when opening a matching filename.
- Saved metadata includes image dimensions.
- If dimensions differ, the app warns but still loads the paths.

Future behavior should move saved guide data to sidecar JSON files.

## UI Requirements

Top title bar:

- Centered bold title: `Serigraphica`.
- Current status text at top right.

Right panel sections:

- `File`: `Open` and read-only filename textbox.
- `Window`: zoom percentage, `Fit`, `100%`.
- `Guides`: `Draw | Pan`, rectangle list, `Reset Lines | Save Lines`, `Hide Mesh | Hide Handles`.
- `Mesh`: density slider and `Dewarp` button.
- `Fill`: shape count, `Add | Reset | Fill/Unfill/Refill`.
- `Export`: `Export | Export As`.

The rectangle list is always visible in its own box and at least three rows tall.

## Technical Requirements

- Electron desktop shell.
- React renderer.
- Canvas-based image display and geometry editing.
- Python sidecar for metadata, dewarp, perspective fallback, and fill.
- OpenCV and NumPy for image operations.
- Optional local LaMa ONNX model at `models/inpainting_lama_2025jan.onnx`.
- `models/` content is ignored by git except `.gitkeep`.
- `output/` is ignored by git except `.gitignore`.
- MIT licensed.

## Verification Baseline

Current available checks:

- `npm run typecheck`
- `npm run build`
- `npm run lint --if-present`
- `python/.venv/bin/python3 -m py_compile python/sidecar.py python/transform.py`
- `git diff --check`

There is currently no explicit lint script in `package.json`; `npm run lint --if-present` is a no-op unless lint tooling is added.

## Current Limitations

- Saved guides are localStorage-based, not portable sidecar files.
- Fill masks are four-point polygons only.
- Fill progress/cancel is not implemented.
- LaMa requires the user to provide the ONNX model locally.
- Mesh foldover checks should be made stricter before broad production use.
- There are no automated unit tests yet.

## Near-Term Tasks

1. Add portable sidecar JSON save/load for guides and fill masks.
2. Add foldover validation and user-facing mesh error reporting.
3. Add fill progress and cancellation.
4. Add per-shape fill list/delete controls.
5. Add automated smoke tests for nested dewarp geometry and fill fallback.
6. Add a real lint script and formatting policy.
7. Package/install LaMa model handling without committing model weights.

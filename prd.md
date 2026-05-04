# Serigraphica Product Requirements

## Purpose

Serigraphica is a desktop geometry-correction tool for photographed serigraphs, posters, prints, and other rectangular paper artwork.

The app corrects perspective and later local paper warp by using two user-marked rectangular boundaries:

- Outer paper boundary
- Inner print or plate-mark boundary

The first reliable workflow is manual. The user marks both rectangles with pen-tool-style paths, then adjusts nodes and symmetric Bezier handles directly on the image.

## Current Pivot

Automated edge fitting is no longer part of the active MVP. It produced unreliable results and made the workflow harder to reason about. The app should now prioritize precise, fast manual boundary placement.

The core interaction is:

1. Open an image.
2. Use Outer Pen to mark the outer paper rectangle.
3. Use Inner Pen to mark the inner print rectangle.
4. Add side nodes by clicking directly on an existing side.
5. Drag nodes and symmetric handles to match warped paper/print edges.
6. Export a corrected image using the outer rectangle for the current perspective-only export.

## Problem

Photographed serigraphs often have visible geometric distortion:

- Camera is not square to the artwork.
- Paper is curled, bowed, or moved by wind.
- The easel, clips, shadows, and artwork texture can obscure real boundaries.
- The visible outer paper edge and inner print edge are both important geometric constraints.
- General photo editors can correct simple perspective, but manually doing this across many images is slow and inconsistent.

The important product insight remains unchanged: most target images contain two rectangular structures that should be rectangular after correction.

## Goals

- Let the user manually mark both outer and inner rectangular boundaries.
- Make node and handle manipulation fast enough for repeated image work.
- Support adding side nodes where paper curvature requires more control.
- Preserve source files and export corrected copies.
- Use the outer rectangle for current perspective crop/export.
- Keep the data model suitable for later dewarp work using both rectangles.
- Avoid unreliable automatic boundary detection in the active workflow.

## Non-Goals

- General-purpose photo editing.
- Color correction, retouching, healing, masking, or compositing.
- Fully automatic boundary detection in the MVP.
- True physical 3D reconstruction of paper shape.
- Correcting severely folded, occluded, or motion-blurred artwork.
- RAW development in the first version.

## Core Concepts

### Image

An imported JPEG or PNG source image. Source files are never modified.

### Boundary Path

A closed path representing one rectangular structure. There are two boundary paths:

- Outer path: paper perimeter.
- Inner path: print or plate-mark perimeter.

Each path starts as four corner nodes. Users may add additional side nodes by clicking on the path. Side nodes have symmetric Bezier handles. Corner nodes remain sharp by default.

### Corner Nodes

Each path has four ordered corner nodes:

- Top-left
- Top-right
- Bottom-right
- Bottom-left

These corners provide the rectangular reference for export and future dewarp interpretation.

### Side Nodes

Side nodes are added between corner nodes. They represent smooth paper or print-edge curvature. Each side node has symmetric handles for now.

### Correction Profile

A saved set of manual outer/inner paths associated with one image. Profiles should be reopenable so the user does not have to redraw paths during testing or repeated export.

## Primary Workflow

1. User opens or drops an image.
2. App displays the image with pan and zoom.
3. Outer Pen is active by default.
4. User clicks four outer paper corners in order around the paper.
5. App closes the outer path and switches to Inner Pen.
6. User clicks four inner print corners in order around the print.
7. User refines each path:
   - Drag corner nodes.
   - Click a path segment to add a side node.
   - Drag side nodes.
   - Drag side-node handles.
8. User projects a mesh inside the outer path to inspect the correction surface.
9. User saves manual paths for the image when desired.
10. User exports corrected output.

## Manual Pen Requirements

- Provide separate tools for Outer Pen and Inner Pen.
- Path colors must be distinct:
  - Outer: red
  - Inner: blue
- Clicking with a pen tool and no path should place corner nodes until four corners exist.
- After four corners exist, the path should close automatically.
- Clicking directly on an existing path segment should insert a side node.
- Cursor should indicate segment insertion, currently using a plus/copy-style cursor.
- Inserted side nodes should have symmetric handles.
- Dragging either handle should mirror the opposite handle through the node.
- Dragging a node should move the node without changing its handle vector.
- Pan mode should still allow view movement.
- Trackpad pan and zoom must remain available.
- Cmd+0 should fit image to view.
- Cmd+1 should zoom to actual size.

## Current Export Requirements

- Export uses the outer path's four corner nodes.
- Output is a perspective-corrected JPEG copy.
- Source image is never modified.
- The current export does not yet use side nodes or the inner path for dewarping.
- Side-node and inner-path data must still be preserved because they are required for future 3D-style dewarp.

## Projected Mesh Requirements

- User can toggle a projected mesh overlay after the outer path exists.
- Mesh is projected inside the outer boundary.
- Mesh boundary follows the outer path, including side nodes and handles.
- Mesh updates live as nodes and handles move.
- Mesh density is adjustable.
- Initial projection may use Coons-style interpolation from the four outer sides.
- Later dewarp work should incorporate the inner path as an internal constraint.

## Future Dewarp Requirements

Later dewarp should use both marked rectangles:

- Outer paper path describes the physical sheet perimeter.
- Inner print path describes the printed rectangle on the same paper surface.
- The relationship between the two paths informs local paper deformation.
- Side nodes and handles should be convertible to sampled curves for mesh generation.

The future dewarp should assume paper bends smoothly. It should not introduce sharp local kinks unless explicitly created by user geometry.

## Save/Load Requirements

- Debug save/load should store manual paths by filename.
- Loading should restore both outer and inner paths.
- Saved data should include image dimensions.
- If dimensions differ on load, app should warn but still allow loading.

## UI Requirements

- Canvas should support drag/drop image loading.
- Empty canvas click should open the file browser.
- Bottom-right debug modal should remain available for path save/load.
- Toolbar should include:
  - Open
  - Pan
  - Outer Pen
  - Inner Pen
  - New Outer
  - New Inner
  - Hide Handles
  - Project Mesh
  - Fit
  - 100%
  - Export
- Side panel should show:
  - Active tool
  - Outer path node count or draft corner count
  - Inner path node count or draft corner count
  - Mesh visibility and density controls
  - Clear controls
  - Basic usage instructions

## Technical Requirements

- Electron desktop app.
- React renderer with canvas-based interaction.
- Python sidecar remains for image metadata and export transforms.
- OpenCV remains acceptable for perspective export.
- Automated boundary detection modules should not be imported or exposed by runtime code.
- Manual path model should be stored in TypeScript shared types.

## Current Limitations

- Export is perspective-only and uses outer corners only.
- Side nodes and handles are visual/editable geometry but not yet used in export.
- Projected mesh is currently a preview overlay, not yet used in export.
- Corner handles are not exposed; corners remain sharp.
- Side-node handles are symmetric only.
- Deleting individual side nodes is not yet implemented.
- Inner path is collected and saved but not yet used for export.

## Near-Term Tasks

1. Add selected-node state.
2. Add delete selected side node.
3. Add side-node handle length reset.
4. Add path serialization to sidecar JSON files instead of localStorage-only debug storage.
5. Add curve sampling utilities for future dewarp.
6. Add export preview that shows outer-corner perspective crop before writing.
7. Begin mesh/dewarp implementation using both outer and inner manual paths.

---

next steps:
i fixed the height manually. 

does the mesh project from just the outside box? we want the mesh to be informed by both boxes - that's the core differentiator

once that is set, next step will be to dewarp the image

then export - which currently exports to the input folder, but shoulld go to a new folder (perhaps /output) whose content is ignroed by git but the folder is there

we also want to reorganize the top bar
from right to left:
section 1
open
section 2
Outer Pen
Inner Pen
Pan
Reset (resets both rectangles)
section 3
Project mesh
Dewarp (shows the crop and dewarping result)
section 4
Export (saves under same name in output folder with "corrected" appended to filename)
Export As (gives user a file dialogue)

move Fit and 100% to the right corner. add a disabled box that shows the current zoom level as well as the filename. fit, 100%, current zoom level, and filename all sit above the right panel. the remaining items (the sections/steps) sit above the main app window. all evenly distributed within their zone

have the debug content always showing as a seperate section at the bottom of the right panel, rather than a popup you have to click

default for "Inverse" text should actually be white, but the slider itself is red to match the app design

move hide handles into the bar on the right with Clear Outer, Clear Inner. rename clear to Reset
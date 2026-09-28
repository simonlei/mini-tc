// Shared drag-and-drop source state for cross-panel file moves.
//
// HTML5 DnD does not let us read the custom payload during `dragover` (only on
// `drop`), so we also stash the drag source here as a module-level singleton.
// Both FileList instances (left/right panel) import the same object, so a drag
// started in one panel is readable when dropped on the other. The values are
// plain strings (source entry names + the source directory), resolved to full
// paths by the drop handler.

export const dragState = {
  // Names of the entries being dragged (relative to `sourcePath`).
  sourceNames: [],
  // The directory those entries live in.
  sourcePath: "",
};

export function clearDragState() {
  dragState.sourceNames = [];
  dragState.sourcePath = "";
}

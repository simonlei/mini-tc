// Module-level singleton shared between FileList (writer) and App (reader).
//
// HTML5 DnD's `dragover`/`drop` events are no longer used (we rely on
// tauri://drag-* + elementFromPoint now). To distinguish a drop that came from
// OUR OWN drag-out from one that came from an external app (e.g. Explorer
// dragging files INTO mini-tc), FileList records the paths it just dragged
// out, and App consults them in the drag-drop handler. A self drag-out is a
// "move" (DROPEFFECT_MOVE); an external drag-in is a "copy".
//
// drag-rs's startDrag runs OLE DoDragDrop synchronously, so by the time
// tauri://drag-drop fires the same paths appear in payload.paths. We compare
// them to what we just sent — if they match, it was our own drag-out.

let lastOutPaths = null;
let lastOutAt = 0;

export function noteDragOut(paths) {
  lastOutPaths = paths.slice().sort();
  lastOutAt = Date.now();
}

export function consumeDragOut(payloadPaths) {
  if (!lastOutPaths || Date.now() - lastOutAt > 5000) return false;
  const incoming = (payloadPaths || []).slice().sort();
  if (incoming.length !== lastOutPaths.length) return false;
  for (let i = 0; i < incoming.length; i++) {
    if (incoming[i] !== lastOutPaths[i]) return false;
  }
  // Consume so the next unrelated drop doesn't get mis-attributed.
  lastOutPaths = null;
  lastOutAt = 0;
  return true;
}
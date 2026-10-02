// Where the person is in the document, kept across a replace in place (the
// file changed on disk, a rewind in the shell's history view): the room's
// scroll, and the cell holding the focus, by its place among the sheet's
// cells, with a code editor's selection. setDoc rebuilds every cell, so
// nothing of the old page survives it; what is kept is positions. A cell
// past the new document's end has no place, and the focus goes nowhere.

import { EditorView } from 'codemirror';

/** Note the place now; the returned function puts it back. */
export function keepPlace(scroller: HTMLElement, sheet: HTMLElement): () => void {
  const top = scroller.scrollTop;
  const cells = () => [...sheet.querySelectorAll<HTMLElement>(':scope > .cell-wrap')];
  const active = document.activeElement;
  const holder = active instanceof Element && sheet.contains(active) ? active.closest<HTMLElement>('.cell-wrap') : null;
  const index = holder ? cells().indexOf(holder) : -1;
  const before = holder?.querySelector<HTMLElement>('.cm-editor');
  const editor = before ? EditorView.findFromDOM(before) : null;
  const selection = editor?.state.selection.main;
  return () => {
    const cell = index >= 0 ? cells()[index] : undefined;
    const view = cell ? EditorView.findFromDOM(cell.querySelector<HTMLElement>('.cm-editor') ?? cell) : null;
    if (view) {
      if (selection) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: Math.min(selection.anchor, end), head: Math.min(selection.head, end) } });
      }
      view.focus();
    } else if (cell?.querySelector('.ProseMirror')) {
      cell.querySelector<HTMLElement>('.ProseMirror')!.focus({ preventScroll: true });
    } else if (document.activeElement instanceof HTMLElement && sheet.contains(document.activeElement)) {
      // Rebuilding may hand the focus to a cell that did not have it.
      document.activeElement.blur();
    }
    scroller.scrollTop = top;
    // Editors measure their lines a frame later, which can move the room.
    requestAnimationFrame(() => {
      scroller.scrollTop = top;
    });
  };
}

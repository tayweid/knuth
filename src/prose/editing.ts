// Trimmed from Plass's src/editing.ts: the generic input rules and keymap
// (Typora-style — markdown-ish syntax renders as you type) plus a small,
// new pair of math input rules reimplemented from math.ts's
// mathInlineRule/mathDisplayRule shape (Plass's live in a Typst-coupled
// module, so they aren't reused directly — the interaction is the same:
// finishing `$...$` makes inline math, `$$` alone on a line makes a
// display block). Dropped: collapseSpaces (Typst space/dash normalization
// — nothing here compiles to Typst), verticalCaret (a workaround for the
// paginated typeset DOM, which this stack doesn't have), and every
// Typst-specific keymap entry (tables, figures, footnotes, page breaks,
// keep-together, arrow-key footnote skipping).

import {
  InputRule,
  inputRules,
  smartQuotes,
  ellipsis,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Plugin } from 'prosemirror-state';
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { Slice, type MarkType } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import { schema } from './schema.ts';

/**
 * `**bold**`, `_em_`, `` `code` `` style mark input rules.
 * `contentGroup` is the capture group holding the marked text; group 1 is a
 * preserved prefix when contentGroup is 2.
 */
function markInputRule(regexp: RegExp, markType: MarkType, contentGroup = 1): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const content = match[contentGroup];
    if (!content) return null;
    const prefix = contentGroup === 2 ? (match[1] ?? '') : '';
    const from = start + prefix.length;
    const tr = state.tr;
    tr.delete(from, end);
    tr.insertText(content, from);
    tr.addMark(from, from + content.length, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  });
}

/** `$...$` becomes inline math as you type the closing dollar. */
const mathInlineRule = new InputRule(/\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, match, start, end) => {
  return state.tr.replaceWith(start, end, schema.nodes.math_inline.create({ src: match[1] }));
});

/** `$$` alone on an empty line becomes a display-math block. */
const mathDisplayRule = new InputRule(/^\$\$$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== schema.nodes.paragraph) return null;
  if ($start.parent.content.size > end - start) return null;
  return state.tr.replaceRangeWith(
    $start.before(),
    $start.after(),
    schema.nodes.math_display.create({ src: '' }),
  );
});

export const proseInputRules: Plugin = inputRules({
  rules: [
    ...smartQuotes,
    ellipsis,
    // # / ## / ### ... headings (schema supports levels 1-6)
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (m) => ({ level: m[1].length })),
    // > blockquote
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    // - or * bullet list
    wrappingInputRule(/^\s*([-*])\s$/, schema.nodes.bullet_list),
    // 1. ordered list
    wrappingInputRule(
      /^(\d+)\.\s$/,
      schema.nodes.ordered_list,
      (m) => ({ order: +m[1] }),
      (m, node) => node.childCount + node.attrs.order === +m[1],
    ),
    // ``` code block
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
    // marks
    markInputRule(/\*\*([^*]+)\*\*$/, schema.marks.strong),
    // Emphasis openers must sit at a word boundary: an intra-word _ or *
    // (A_C subscripts, a* optimal values) never opens italics — otherwise
    // a later closing character italicizes everything since.
    markInputRule(/(^|[^\w*])\*([^*\s][^*]*)\*$/, schema.marks.em, 2),
    markInputRule(/(^|[^\w_])_([^_\s][^_]*)_$/, schema.marks.em, 2),
    markInputRule(/`([^`]+)`$/, schema.marks.code),
    markInputRule(/~~([^~\s][^~]*)~~$/, schema.marks.strike),
    // math
    mathInlineRule,
    mathDisplayRule,
  ],
});

export const proseKeymap: Plugin = keymap({
  ...baseKeymap,
  'Mod-z': undo,
  'Shift-Mod-z': redo,
  'Mod-y': redo,
  'Mod-b': toggleMark(schema.marks.strong),
  'Mod-i': toggleMark(schema.marks.em),
  'Mod-Shift-x': toggleMark(schema.marks.strike),
  'Mod-`': toggleMark(schema.marks.code),
  'Shift-Mod-8': wrapInList(schema.nodes.bullet_list),
  'Shift-Mod-9': wrapInList(schema.nodes.ordered_list),
  'Mod-Alt-0': setBlockType(schema.nodes.paragraph),
  'Mod-Alt-1': setBlockType(schema.nodes.heading, { level: 1 }),
  'Mod-Alt-2': setBlockType(schema.nodes.heading, { level: 2 }),
  'Mod-Alt-3': setBlockType(schema.nodes.heading, { level: 3 }),
  'Ctrl->': wrapIn(schema.nodes.blockquote),
  // Split the list item first; outside a list this falls through to
  // baseKeymap's own Enter (paragraph split).
  'Enter': chainCommands(splitListItem(schema.nodes.list_item), baseKeymap.Enter as Command),
  'Tab': sinkListItem(schema.nodes.list_item),
  'Shift-Tab': liftListItem(schema.nodes.list_item),
  'Shift-Enter': chainCommands(exitCode, (state, dispatch) => {
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
    }
    return true;
  }),
} as Record<string, Command>);

/** Copying TEXT out of a bullet copies the text, not the bullet.
 *
 *  ProseMirror slices a selection at its own depth, so highlighting the words
 *  in a list item yields ul > li > p rather than the words: paste that onto an
 *  empty line and the line becomes a bullet. But a selection that begins and
 *  ends inside ONE textblock carries no structure the user chose — they
 *  dragged across words, not across blocks — so the words alone are what was
 *  copied. Selections that really do span blocks keep every level they cross,
 *  which is what makes copying two bullets still paste as two bullets.
 */
export function copyTextWithoutItsBlock(): Plugin {
  return new Plugin({
    props: {
      transformCopied(slice) {
        // Equal open depths on both sides is what "inside one block" looks
        // like; anything else spans a boundary and keeps its structure.
        if (slice.openStart < 1 || slice.openStart !== slice.openEnd) return slice;
        let content = slice.content;
        for (let depth = 0; depth < slice.openStart; depth++) {
          if (content.childCount !== 1) return slice;
          content = content.child(0).content;
        }
        // Only unwrap if what is left really is inline — the same shape can
        // bottom out at a list item (select-all in a one-item list), and that
        // is a structural copy however it was made.
        if (content.childCount && !content.child(0).isInline) return slice;
        return new Slice(content, 0, 0);
      },
    },
  });
}

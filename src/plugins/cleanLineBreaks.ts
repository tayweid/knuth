/**
 * Clean line break handling for pymd.
 *
 * - On load: detect \n\n\n+ in source, insert empty paragraphs after parsing
 * - On save: convert <br /> and \ breaks to plain \n
 */

import type { Node as ProseNode, Schema } from "@milkdown/kit/prose/model";
import { Fragment } from "@milkdown/kit/prose/model";

/**
 * Find where extra blank lines exist in the markdown source.
 * Returns a map of: block index → number of empty paragraphs to insert after it.
 *
 * We split the markdown by block boundaries (\n\n) and count
 * consecutive empty blocks (which represent extra blank lines).
 */
export function findBlankLinePositions(markdown: string): Map<number, number> {
  const positions = new Map<number, number>();

  // Split into blocks separated by \n\n
  const blocks = markdown.split(/\n\n/);

  let realBlockIndex = -1;
  let pendingBlanks = 0;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed === "") {
      // Empty block = extra blank line
      pendingBlanks++;
    } else {
      realBlockIndex++;
      if (pendingBlanks > 0 && realBlockIndex > 0) {
        // Insert blank paragraphs before this block (after the previous one)
        positions.set(realBlockIndex, pendingBlanks);
      }
      pendingBlanks = 0;
    }
  }

  return positions;
}

/**
 * Insert empty paragraph nodes into a parsed document where
 * extra blank lines existed in the source markdown.
 */
export function insertBlankParagraphs(
  markdown: string,
  doc: ProseNode,
  schema: Schema
): ProseNode {
  const positions = findBlankLinePositions(markdown);

  if (positions.size === 0) return doc;

  const emptyParagraph = schema.nodes.paragraph.create();
  const newChildren: ProseNode[] = [];
  let blockIndex = 0;

  doc.forEach((child) => {
    // Check if we need to insert blank paragraphs before this block
    const blanks = positions.get(blockIndex);
    if (blanks) {
      for (let i = 0; i < blanks; i++) {
        newChildren.push(emptyParagraph);
      }
    }
    newChildren.push(child);
    blockIndex++;
  });

  return doc.copy(Fragment.from(newChildren));
}

/**
 * Post-process markdown after Milkdown serializes it.
 * Converts <br /> and backslash breaks back to plain newlines.
 */
export function cleanMarkdownOutput(markdown: string): string {
  let cleaned = markdown.replace(/<br\s*\/?>/g, "\n");
  cleaned = cleaned.replace(/\\\n/g, "\n");
  return cleaned;
}

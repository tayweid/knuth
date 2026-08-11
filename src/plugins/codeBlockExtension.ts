/**
 * Extends Milkdown's code_block schema to preserve the meta portion
 * of fenced code block info strings.
 *
 * Standard markdown:  ```python exec hide
 * Remark AST:         { type: "code", lang: "python", meta: "exec hide" }
 * Milkdown default:   { language: "python" }  ← meta is lost!
 * With this plugin:   { language: "python exec hide" }  ← full info preserved
 *
 * This allows parseCodeBlockInfo("python exec hide") to detect exec/hide flags.
 */

import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";

export const codeBlockWithMeta = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const baseSchema = prev(ctx);
  return {
    ...baseSchema,
    parseMarkdown: {
      match: (node: any) => node.type === "code",
      runner: (state: any, node: any, type: any) => {
        const lang = node.lang ?? "";
        const meta = node.meta ?? "";
        // Combine lang and meta into the language attribute
        // Default to exec if no meta is specified (but not for LaTeX blocks)
        const isLatex = lang.toLowerCase() === "latex";
        const language = meta ? `${lang} ${meta}` : (lang && !isLatex) ? `${lang} exec` : lang;
        const value = node.value as string;
        state.openNode(type, { language });
        if (value) {
          state.addText(value);
        }
        state.closeNode();
      },
    },
    toMarkdown: {
      match: (node: any) => node.type.name === "code_block",
      runner: (state: any, node: any) => {
        const fullLang = (node.attrs.language || "") as string;
        // Split back: first word is lang, rest is meta
        const parts = fullLang.trim().split(/\s+/);
        const lang = parts[0] || "";
        const meta = parts.slice(1).join(" ") || undefined;
        state.addNode("code", undefined, node.content.firstChild?.text || "", {
          lang,
          meta,
        });
      },
    },
  };
});

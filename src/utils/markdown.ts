/**
 * Markdown utilities for pymd.
 *
 * The file format is plain markdown with executable fenced code blocks:
 *
 *   ```python exec
 *   print("hello")
 *   ```
 *
 * And inline computed values: {{variable_name}}
 *
 * Milkdown handles markdown ↔ document model conversion natively.
 * These helpers handle pymd-specific features.
 */

/**
 * Interpolate {{variable}} expressions in markdown text
 * using values from the Python execution namespace.
 */
export function interpolate(
  markdown: string,
  namespace: Record<string, string>
): string {
  return markdown.replace(/\{\{(.+?)\}\}/g, (_match, expr) => {
    const key = expr.trim();
    return key in namespace ? namespace[key] : `{{${key}}}`;
  });
}

/**
 * Extract exec block metadata from a fenced code block info string.
 * e.g., "python exec hide rerun" → { language: "python", exec: true, hide: true, rerun: true }
 */
export function parseCodeBlockInfo(info: string): {
  language: string;
  exec: boolean;
  hide: boolean;
  rerun: boolean;
} {
  const trimmed = info.trim();
  const parts = trimmed.split(/\s+/);
  const lang = parts[0] || "";
  const hasExplicitStatic = parts.includes("static");
  const hasExplicitExec = parts.includes("exec");
  const hasLanguage = lang.length > 0;
  return {
    language: lang || "text",
    // Only default to exec if a language is specified (not plain ``` blocks)
    exec: hasExplicitStatic ? false : hasExplicitExec || (hasLanguage && !hasExplicitStatic && lang.toLowerCase() !== "text" && lang.toLowerCase() !== "latex"),
    hide: parts.includes("hide"),
    rerun: parts.includes("rerun"),
  };
}

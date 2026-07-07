import type { StageTransform } from './types.ts';

/**
 * `//` → `/* *\/` (design doc §6 "// (silent comment)" row; §8.1 stage 1 `comments`; §13.2 Step 10).
 *
 * postcss-scss marks a silent (`//`) comment with `raws.inline === true`; a loud (`/* *\/`)
 * comment has no such flag. Converting is therefore just clearing the flag: once `raws.inline`
 * is no longer `true`, the SCSS stringifier falls back to its default loud-comment rendering
 * (`/* ... *\/`), and `raws.left` / `raws.right` (the whitespace immediately inside the
 * delimiters) are reused unchanged, so indentation and surrounding formatting are preserved.
 *
 * **`*\/` inside the comment body**: wrapping the text verbatim in `/* ... *\/` would let an
 * embedded `*\/` close the comment early and corrupt the output. Since this stage assumes a
 * minifier removes comments from the final build anyway (design doc §1 "前提", §8.1 "構築的に
 * 等価"), a small change to the comment's own text is an acceptable price for staying valid CSS:
 * every `*\/` inside the body is replaced with `* /` (a space is inserted between the two
 * characters) before wrapping. postcss-scss's own parser already applies a similar but different
 * fixup to `Comment#text` when it parses a silent comment; this stage instead reads the
 * un-fixed-up original from `raws.text` and applies its own substitution, so the output matches
 * what's documented and tested here.
 *
 * Idempotent: a comment without `raws.inline === true` (already loud, or already converted) is
 * left untouched.
 */
export const transformComments: StageTransform = (root) => {
  root.walkComments((comment) => {
    if (comment.raws.inline !== true) return;

    const original = typeof comment.raws.text === 'string' ? comment.raws.text : comment.text;
    comment.text = original.replaceAll('*/', '* /');
    delete comment.raws.text;
    comment.raws.inline = false;
    // A silent comment has no closing delimiter, so its `raws.right` is usually empty — an
    // artifact of the syntax, not the author's formatting. Pad it so the loud form reads
    // `/* note */` rather than `/* note*/`.
    if (comment.text !== '' && (comment.raws.right === undefined || comment.raws.right === '')) {
      comment.raws.right = ' ';
    }
  });

  return { diagnostics: [], logs: [] };
};

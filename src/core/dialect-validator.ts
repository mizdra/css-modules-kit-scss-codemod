import path from 'node:path';
import type { AtRule, Declaration, Root, Rule } from 'postcss';
import postcss, { CssSyntaxError } from 'postcss';
import postcssMixins from 'postcss-mixins';
import postcssNested from 'postcss-nested';
import selectorParser from 'postcss-selector-parser';
import postcssSimpleVars from 'postcss-simple-vars';
import valueParser from 'postcss-value-parser';
import type { PositionedNode } from './classify-value.ts';
import { isPlainCssImport, KNOWN_CSS_AT_RULES } from './classify.ts';
import type { Diagnostic } from './diagnostic.ts';
import { parseScss } from './parse.ts';
import { CSS_MATH_FUNCTIONS } from './sass-builtin-functions.ts';

/**
 * PostCSS at-rule names for postcss-mixins definitions/applications (design doc §4):
 * `@define-mixin` (definition), `@mixin` (application, distinct from Sass's definition
 * keyword of the same spelling), `@mixin-content` (content block placeholder).
 */
const MIXIN_AT_RULE_NAMES: ReadonlySet<string> = new Set(['define-mixin', 'mixin', 'mixin-content']);

/** A bare `+`/`*`/`-` word token is Sass arithmetic; CSS never uses a standalone operator token. */
const STANDALONE_OPERATORS: ReadonlySet<string> = new Set(['+', '*', '-']);

/** `ident.ident` or `ident.$var` (e.g. `t.$primary`, standalone namespaced word). Requires a letter/underscore lead on both sides so numeric literals (`1.5`) never match. */
const NAMESPACE_WORD = /^[A-Za-z_][\w-]*\.\$?[A-Za-z_][\w-]*$/u;

/** A bare `$var` property name — a variable declaration. Distinct from `$(x)` (an interpolated property name, e.g. simple-vars' "whole prop name is a variable" form), which is always allowed. */
const VARIABLE_DECLARATION_PROP = /^\$[\w-]+$/u;

const INTERPOLATION_MESSAGE =
  "Sass interpolation `#{}` is not part of the dialect; the dialect's interpolation syntax is `$(x)`.";

interface NodeStart {
  readonly line: number | undefined;
  readonly column: number | undefined;
}

function nodeStart(node: { source?: { start?: { line: number; column: number } } }): NodeStart {
  const start = node.source?.start;
  return { line: start?.line, column: start?.column };
}

function diagnosticAt(
  node: { source?: { start?: { line: number; column: number } } },
  file: string,
  syntax: string,
  message: string,
): Diagnostic {
  const position = nodeStart(node);
  return { file, line: position.line, column: position.column, syntax, message };
}

function diagnosticAtOffset(
  node: PositionedNode,
  file: string,
  offset: number,
  syntax: string,
  message: string,
): Diagnostic {
  const position = node.positionInside(offset);
  return { file, line: position.line, column: position.column, syntax, message };
}

function declValueOffset(decl: Declaration): number {
  return decl.prop.length + (decl.raws.between ?? ': ').length;
}

/**
 * Walks `decl.value` for the two value-level checks that need per-token position:
 * a namespace reference (`t.$primary`, `math.div(...)`) and Sass arithmetic outside a CSS
 * math function. `/` is deliberately not checked: it cannot be told apart from the CSS
 * shorthand separator (`font: 16px/1.5`, `grid-area: 1 / 2`) without evaluating operands.
 */
function checkDeclValue(decl: Declaration, file: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const offsetBase = declValueOffset(decl);

  function walk(nodes: readonly valueParser.Node[], insideMathFunction: boolean): void {
    for (const node of nodes) {
      if (node.type === 'word') {
        if (NAMESPACE_WORD.test(node.value)) {
          diagnostics.push(
            diagnosticAtOffset(
              decl,
              file,
              offsetBase + node.sourceIndex,
              'namespaced reference',
              `Namespaced reference \`${node.value}\` has no dialect equivalent; the dialect has no module namespaces.`,
            ),
          );
        } else if (STANDALONE_OPERATORS.has(node.value) && !insideMathFunction) {
          diagnostics.push(
            diagnosticAtOffset(
              decl,
              file,
              offsetBase + node.sourceIndex,
              'Sass arithmetic outside calc()',
              'Sass arithmetic operators are not evaluated by the dialect; wrap the expression in `calc()` or another CSS math function.',
            ),
          );
        }
      } else if (node.type === 'function') {
        if (node.value.includes('.')) {
          diagnostics.push(
            diagnosticAtOffset(
              decl,
              file,
              offsetBase + node.sourceIndex,
              'namespaced reference',
              `Namespaced function \`${node.value}()\` has no dialect equivalent; the dialect has no module namespaces.`,
            ),
          );
          // Arguments of a namespaced call are full SassScript, not CSS — do not descend.
          continue;
        }
        const childInsideMathFunction = insideMathFunction || CSS_MATH_FUNCTIONS.has(node.value.toLowerCase());
        walk(node.nodes, childInsideMathFunction);
      }
    }
  }

  walk(valueParser(decl.value).nodes, false);
  return diagnostics;
}

/** Declaration-level checks (design doc §13.1: local `$var`, `#{}`, namespace reference, Sass arithmetic). */
function checkDecl(decl: Declaration, file: string): Diagnostic[] {
  const prop = decl.prop;

  if (VARIABLE_DECLARATION_PROP.test(prop) && decl.parent?.type !== 'root') {
    return [
      diagnosticAt(
        decl,
        file,
        'local variable declaration',
        'Local Sass-style variable declarations are only allowed at the top level of a file; the dialect has no block scoping.',
      ),
    ];
  }

  if (prop.includes('#{') || decl.value.includes('#{')) {
    return [diagnosticAt(decl, file, 'Sass interpolation `#{}`', INTERPOLATION_MESSAGE)];
  }

  return checkDeclValue(decl, file);
}

/** Rule (selector) checks: `#{}` and placeholder selectors reject; `&` (including concatenation) is allowed as-is. */
function checkRule(rule: Rule, file: string): Diagnostic[] {
  if (rule.selector.includes('#{')) {
    return [diagnosticAt(rule, file, 'Sass interpolation `#{}`', INTERPOLATION_MESSAGE)];
  }

  let root: selectorParser.Root;
  try {
    root = selectorParser().astSync(rule.selector);
  } catch {
    return [diagnosticAt(rule, file, 'unparsable selector', 'The selector could not be parsed.')];
  }

  const diagnostics: Diagnostic[] = [];
  root.walk((node) => {
    if (node.type === 'tag' && node.value.startsWith('%')) {
      diagnostics.push(
        diagnosticAt(
          rule,
          file,
          'placeholder selector',
          'Placeholder selectors (`%foo`) have no dialect equivalent; expand the rule manually or convert it to a class.',
        ),
      );
    }
  });
  return diagnostics;
}

/** At-rule checks: whitelist of `postcss-mixins` keywords, plain-CSS `@import`, and known CSS at-rules; everything else rejects (fail-closed). */
function checkAtRule(atrule: AtRule, file: string): Diagnostic[] {
  const name = atrule.name;

  if (MIXIN_AT_RULE_NAMES.has(name)) return [];

  if (name === 'import') {
    if (isPlainCssImport(atrule.params)) return [];
    return [
      diagnosticAt(
        atrule,
        file,
        'Sass @import',
        'Sass-style `@import` (without a `.css` extension or `url()`) is not part of the dialect; run the `modules` stage first.',
      ),
    ];
  }

  const lowered = name.toLowerCase().replace(/^-\w+-/u, '');
  if (KNOWN_CSS_AT_RULES.has(lowered)) {
    if (atrule.params.includes('#{')) {
      return [diagnosticAt(atrule, file, 'Sass interpolation `#{}`', INTERPOLATION_MESSAGE)];
    }
    return [];
  }

  return [diagnosticAt(atrule, file, `@${name}`, `"@${name}" is not part of the dialect.`)];
}

/**
 * Whitelist walk over a single file's AST (design doc §8.3, §13.1). Parsing the file with
 * postcss-scss (not the standard postcss parser) matters here: the standard parser silently
 * accepts several residual Sass constructs (e.g. `$var: 1 + 2;` reads as an ordinary
 * declaration), so it cannot be relied on to reject them.
 */
function checkWhitelist(root: Root, file: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  root.walk((node) => {
    if (node.type === 'comment') {
      if (node.raws.inline === true) {
        diagnostics.push(
          diagnosticAt(
            node,
            file,
            'silent comment',
            'Sass silent comments (`//`) are not part of the dialect; convert them to `/* */` first.',
          ),
        );
      }
      return;
    }
    if (node.type === 'decl') {
      diagnostics.push(...checkDecl(node, file));
      return;
    }
    if (node.type === 'atrule') {
      diagnostics.push(...checkAtRule(node, file));
      return;
    }
    if (node.type === 'rule') {
      diagnostics.push(...checkRule(node, file));
    }
  });

  return diagnostics;
}

/** The quoted specifier of an `@import` (`@import './theme.css';` → `./theme.css`), or `undefined` for `url(...)`/malformed params. */
function extractQuotedSpecifier(params: string): string | undefined {
  const match = /^\s*(['"])((?:\\.|(?!\1).)*)\1/u.exec(params);
  return match?.[2];
}

/** Collects `@import` at-rules without mutating `root` (a plain snapshot, safe to iterate while splicing elsewhere). */
function collectImportAtRules(root: Root): AtRule[] {
  const atrules: AtRule[] = [];
  root.walkAtRules('import', (atrule) => {
    atrules.push(atrule);
  });
  return atrules;
}

/**
 * Recursively inlines `@import`s that resolve (relative path) to another file in `files`,
 * mirroring per-importer inline semantics (design doc §9.3, `@import` row; §10.1). Imports
 * that don't resolve into `files` (external packages, `url()`, non-relative specifiers) are
 * left in place.
 *
 * Iterates a pre-collected, static array of `@import` nodes (`collectImportAtRules`) rather
 * than a live `root.walkAtRules` callback: splicing in already-fully-resolved content
 * (`atrule.replaceWith`) would otherwise re-enter the walk over the newly-inserted nodes with
 * a *different* (shorter, incorrect) `stack` closure, which can defeat cycle detection and
 * loop indefinitely. `stack` is the chain of files currently being inlined (for cycle
 * detection only, not a global "already visited" set — the same file may legitimately be
 * inlined into multiple independent branches, e.g. a shared reset imported by two files).
 */
function inlineFile(
  file: string,
  parsedRoots: ReadonlyMap<string, Root>,
  files: ReadonlyMap<string, string>,
  stack: readonly string[],
  diagnostics: Diagnostic[],
): Root {
  const original = parsedRoots.get(file);
  if (!original) throw new Error(`dialect-validator: no parsed AST for "${file}"`);
  const root = original.clone();
  const nextStack = [...stack, file];

  for (const atrule of collectImportAtRules(root)) {
    const specifier = extractQuotedSpecifier(atrule.params);
    if (specifier === undefined || !specifier.startsWith('.')) continue; // not a relative specifier — external, leave as-is
    const resolved = path.resolve(path.dirname(file), specifier);
    if (!files.has(resolved)) continue; // outside the given file set — external, leave as-is

    if (nextStack.includes(resolved)) {
      diagnostics.push(
        diagnosticAt(atrule, file, '@import', `Circular @import: ${[...nextStack, resolved].join(' -> ')}`),
      );
      continue; // leave unexpanded — breaks the cycle without recursing further
    }

    const importedRoot = inlineFile(resolved, parsedRoots, files, nextStack, diagnostics);
    const nodes = importedRoot.nodes.map((node) => node.clone());
    if (nodes.length > 0) atrule.replaceWith(...nodes);
    else atrule.remove();
  }

  return root;
}

/** Maps a `postcss.CssSyntaxError` thrown by the plugin pipeline or the final standard-CSS parse to a `Diagnostic`. */
function diagnosticFromCssSyntaxError(error: CssSyntaxError, file: string, syntax: string): Diagnostic {
  return { file, line: error.line, column: error.column, syntax, message: error.reason };
}

/**
 * Runs the actual target dialect pipeline (design doc §4: postcss-mixins → postcss-simple-vars
 * → postcss-nested) and confirms its output parses as standard CSS. Reused across files —
 * verified empirically that postcss-mixins/postcss-simple-vars do not leak state (defined
 * mixins/variables) across independent `.process()` calls on the same `Processor`.
 */
const dialectPipeline = postcss([postcssMixins(), postcssSimpleVars(), postcssNested()]);

/**
 * Runs the plugin pipeline for a single file (already-inlined) and confirms the output
 * parses as standard CSS (design doc §8.3, §13.1): a plugin throw (undefined mixin/variable)
 * or an unparsable output are both diagnostics.
 */
async function checkPluginPipeline(file: string, css: string): Promise<Diagnostic[]> {
  let processedCss: string;
  try {
    const result = await dialectPipeline.process(css, { from: file });
    processedCss = result.css;
  } catch (error) {
    if (!(error instanceof CssSyntaxError)) throw error;
    return [diagnosticFromCssSyntaxError(error, file, 'postcss-mixins/postcss-simple-vars/postcss-nested')];
  }

  try {
    postcss.parse(processedCss, { from: file });
  } catch (error) {
    if (!(error instanceof CssSyntaxError)) throw error;
    return [diagnosticFromCssSyntaxError(error, file, 'standard CSS parse of plugin output')];
  }

  return [];
}

/**
 * Validates that `files` (an in-memory, post-rename `.css` file set) are entirely written in
 * the target PostCSS dialect (design doc §4, §8.3's `to-css` precondition, §13.1). Whitelist
 * mismatches are fail-closed: standard-postcss-parseable is not sufficient, only constructs
 * explicitly allowed here pass.
 *
 * Two checks run in sequence: (1) a per-file whitelist walk over a postcss-scss parse, which
 * alone can reliably reject residual Sass-only syntax; (2) only if every file passes that,
 * the actual plugin pipeline is executed (after inlining same-file-set relative `@import`s)
 * and its output is confirmed to parse as standard CSS.
 */
export async function validateDialect(
  files: ReadonlyMap<string, string>,
): Promise<{ readonly diagnostics: readonly Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const parsedRoots = new Map<string, Root>();

  for (const [file, source] of files) {
    const parsed = parseScss(source, file);
    if (!parsed.ok) {
      diagnostics.push(parsed.diagnostic);
      continue;
    }
    parsedRoots.set(file, parsed.root);
    diagnostics.push(...checkWhitelist(parsed.root, file));
  }

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  for (const file of files.keys()) {
    const inlined = inlineFile(file, parsedRoots, files, [], diagnostics);
    // oxlint-disable-next-line eslint/no-await-in-loop
    diagnostics.push(...(await checkPluginPipeline(file, inlined.toString())));
  }

  return { diagnostics };
}

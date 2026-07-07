import type { Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { findInterpolationSpans, sortByPosition } from './classify-value.ts';
import type { SyntaxFinding } from './classify.ts';

const SINGLE_VARIABLE_BODY = /^\$[\w-]+$/u;

function isSingleVariableBody(body: string): boolean {
  return SINGLE_VARIABLE_BODY.test(body.trim());
}

/**
 * Collects every `selector` container: the top-level ones plus those nested inside
 * functional pseudo-classes (`:is(...)`, `:not(...)`, ...), recursively — the placeholder
 * check must not be escapable by wrapping in a pseudo. `sourceIndex` values inside pseudos
 * are absolute within the selector string (verified empirically), so position math is
 * identical at every depth.
 */
function collectSelectorContainers(root: selectorParser.Root): selectorParser.Selector[] {
  const containers: selectorParser.Selector[] = [];
  const visit = (selector: selectorParser.Selector): void => {
    containers.push(selector);
    for (const node of selector.nodes) {
      if (node.type === 'pseudo') {
        for (const child of node.nodes) visit(child);
      }
    }
  };
  root.each((selector) => {
    visit(selector);
  });
  return containers;
}

/**
 * Selector-level classification (design doc §6). Parses `rule.selector` with postcss-selector-parser,
 * which tolerates `#{...}` interpolation. Interpolation positions are computed from a raw
 * brace-counting scan of `rule.selector` (shared with the value-level pass 1), not from
 * postcss-selector-parser's `sourceIndex`, because that index is corrupted for any node
 * whose text contains `#{` (verified empirically against postcss-selector-parser@7.1.4).
 *
 * `&` concatenation (`&_bar`) is intentionally NOT reported: postcss-nested resolves it
 * with Sass-compatible semantics, so it is kept as-is; desugaring it into standalone
 * class selectors is css-codemod's responsibility.
 */
export function classifySelector(rule: Rule, file: string): SyntaxFinding[] {
  const start = rule.source?.start;

  let root: selectorParser.Root;
  try {
    root = selectorParser().astSync(rule.selector);
  } catch {
    return [
      {
        file,
        line: start?.line,
        column: start?.column,
        syntax: 'unparsable selector',
        action: { kind: 'unsupported', milestone: 'never' },
      },
    ];
  }

  const findings: SyntaxFinding[] = [];

  for (const selectorNode of collectSelectorContainers(root)) {
    for (const node of selectorNode.nodes) {
      if (node.type === 'tag' && node.value.startsWith('%')) {
        const position = rule.positionInside(node.sourceIndex);
        findings.push({
          file,
          line: position.line,
          column: position.column,
          syntax: 'placeholder selector',
          action: { kind: 'unsupported', milestone: 'never' },
        });
      }
    }
  }

  // Sass evaluates interpolation everywhere in a selector, including inside attribute
  // selectors (`[data-state="#{$state}"]`), so no span is excluded from classification.
  for (const span of findInterpolationSpans(rule.selector)) {
    const position = rule.positionInside(span.start);
    const singleVariable = isSingleVariableBody(span.body);
    findings.push({
      file,
      line: position.line,
      column: position.column,
      syntax: singleVariable ? 'interpolation' : 'interpolation containing an expression',
      action: singleVariable
        ? { kind: 'convert', stage: 'interpolation' }
        : {
            kind: 'unsupported',
            milestone: 'never',
            hint: 'Interpolation containing an expression has no dialect equivalent; pre-compute the value or restructure the code so the interpolation body is a single variable.',
          },
    });
  }

  return sortByPosition(findings);
}

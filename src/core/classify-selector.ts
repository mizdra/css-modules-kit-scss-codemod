import type { Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { findInterpolationSpans, type InterpolationSpan, sortByPosition } from './classify-value.ts';
import type { SyntaxFinding } from './classify.ts';

const SINGLE_VARIABLE_BODY = /^\$[\w-]+$/u;

function isSingleVariableBody(body: string): boolean {
  return SINGLE_VARIABLE_BODY.test(body.trim());
}

/**
 * Collects every `selector` container: the top-level ones plus those nested inside
 * functional pseudo-classes (`:is(...)`, `:not(...)`, ...), recursively — placeholder and
 * concatenation checks must not be escapable by wrapping in a pseudo. `sourceIndex` values
 * inside pseudos are absolute within the selector string (verified empirically), so
 * position math is identical at every depth.
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

interface ConcatenationPair {
  readonly nesting: selectorParser.Nesting;
  readonly tag: selectorParser.Tag;
  readonly nestingFirst: boolean;
}

function matchConcatenationPair(a: selectorParser.Node, b: selectorParser.Node): ConcatenationPair | undefined {
  if (a.type === 'nesting' && b.type === 'tag') return { nesting: a, tag: b, nestingFirst: true };
  if (a.type === 'tag' && b.type === 'nesting') return { nesting: b, tag: a, nestingFirst: false };
  return undefined;
}

/**
 * The raw text range the concatenated `tag` occupies. postcss-selector-parser's own
 * `sourceIndex` for a tag containing `#{...}` is unreliable (verified empirically: it's
 * computed from the wrong underlying token once a word is split by interpolation), so the
 * range is derived from the always-reliable `nesting` node (`&` is always exactly 1 char)
 * instead of trusting `tag.sourceIndex` directly.
 */
function tagRange(pair: ConcatenationPair): { readonly start: number; readonly end: number } {
  if (pair.nestingFirst) {
    const start = pair.nesting.sourceIndex + 1;
    return { start, end: start + pair.tag.value.length };
  }
  const end = pair.nesting.sourceIndex;
  return { start: end - pair.tag.value.length, end };
}

/**
 * Selector-level classification (design doc §6). Parses `rule.selector` with postcss-selector-parser,
 * which tolerates `#{...}` interpolation. Interpolation positions are computed from a raw
 * brace-counting scan of `rule.selector` (shared with the value-level pass 1), not from
 * postcss-selector-parser's `sourceIndex`, because that index is corrupted for any node
 * whose text contains `#{` (verified empirically against postcss-selector-parser@7.1.4).
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
  // Sass evaluates interpolation everywhere in a selector, including inside attribute
  // selectors (`[data-state="#{$state}"]`), so no span is excluded from classification.
  const spans = findInterpolationSpans(rule.selector);
  const consumed = new Set<InterpolationSpan>();

  for (const selectorNode of collectSelectorContainers(root)) {
    const nodes = selectorNode.nodes;
    nodes.forEach((node) => {
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
    });

    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      if (!a || !b) continue;
      const pair = matchConcatenationPair(a, b);
      if (!pair) continue;
      // No combinator sits between them (guaranteed by array adjacency) and no whitespace either.
      if (a.spaces.after !== '' || b.spaces.before !== '') continue;

      const position = rule.positionInside(pair.nesting.sourceIndex);
      const hasInterpolation = pair.tag.value.includes('#{');
      if (hasInterpolation) {
        findings.push({
          file,
          line: position.line,
          column: position.column,
          syntax: 'selector concatenation with interpolation',
          action: { kind: 'unsupported', milestone: 'never' },
        });
        const range = tagRange(pair);
        for (const span of spans) {
          if (span.start >= range.start && span.start < range.end) consumed.add(span);
        }
      } else {
        findings.push({
          file,
          line: position.line,
          column: position.column,
          syntax: 'selector concatenation',
          action: { kind: 'convert', stage: 'nesting' },
        });
      }
    }
  }

  for (const span of spans) {
    if (consumed.has(span)) continue;
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

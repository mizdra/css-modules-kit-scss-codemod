import type { AtRule, Declaration, Root } from 'postcss';
import valueParser from 'postcss-value-parser';
import { findStage, type StageName } from '../stages.ts';
import { classifySelector } from './classify-selector.ts';
import {
  classifyInterpolationOnly,
  classifyValue,
  extractParenArgs,
  findInterpolationSpans,
  maskInterpolationSpans,
  type NamespaceMap,
  type ResolvedNamespace,
} from './classify-value.ts';
import type { Diagnostic, DiagnosticMilestone } from './diagnostic.ts';

/** What to do with a Sass construct: convert it via a stage, or reject it (whitelist mismatch). */
export type SyntaxAction =
  | { readonly kind: 'convert'; readonly stage: StageName }
  | { readonly kind: 'unsupported'; readonly milestone: 'M3' | 'never'; readonly hint?: string };

export interface SyntaxFinding {
  readonly file: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
  /** Name of the Sass construct, e.g. `'@extend'`, `'silent comment'`, `'map/list value'`. */
  readonly syntax: string;
  readonly action: SyntaxAction;
}

const SINGLE_VARIABLE_BODY = /^\$[\w-]+$/u;

const KNOWN_CSS_AT_RULES: ReadonlySet<string> = new Set([
  'media',
  'supports',
  'keyframes',
  'font-face',
  'container',
  'layer',
  'property',
  'page',
  'charset',
  'namespace',
  'scope',
  'starting-style',
  'position-try',
  'font-feature-values',
  'counter-style',
  'view-transition',
  'font-palette-values',
  'custom-media',
  'custom-selector',
]);

interface NodeStart {
  readonly line: number | undefined;
  readonly column: number | undefined;
}

function nodeStart(node: { source?: { start?: { line: number; column: number } } }): NodeStart {
  const start = node.source?.start;
  return { line: start?.line, column: start?.column };
}

function pushUnsupportedAtNode(
  findings: SyntaxFinding[],
  file: string,
  node: { source?: { start?: { line: number; column: number } } },
  syntax: string,
  milestone: 'M3' | 'never',
  hint?: string,
): void {
  const position = nodeStart(node);
  findings.push({
    file,
    line: position.line,
    column: position.column,
    syntax,
    action: hint === undefined ? { kind: 'unsupported', milestone } : { kind: 'unsupported', milestone, hint },
  });
}

function pushConvertAtNode(
  findings: SyntaxFinding[],
  file: string,
  node: { source?: { start?: { line: number; column: number } } },
  syntax: string,
  stage: StageName,
): void {
  const position = nodeStart(node);
  findings.push({ file, line: position.line, column: position.column, syntax, action: { kind: 'convert', stage } });
}

function containsFlag(value: string, flag: '!default' | '!global'): boolean {
  return value.split(/\s+/u).includes(flag);
}

/** Whether `value`'s first significant token is a paren group (`(a: 1, b: 2)`), i.e. a Sass map/list literal. */
function isMapOrListLiteral(value: string): boolean {
  const spans = findInterpolationSpans(value);
  const masked = maskInterpolationSpans(value, spans);
  const parsed = valueParser(masked);
  const first = parsed.nodes.find((node) => node.type !== 'space');
  return first !== undefined && first.type === 'function' && first.value === '';
}

function isSingleVariableBody(body: string): boolean {
  return SINGLE_VARIABLE_BODY.test(body.trim());
}

function declValueOffset(decl: Declaration): number {
  return decl.prop.length + (decl.raws.between ?? ': ').length;
}

function atRuleParamsOffset(atrule: AtRule): number {
  return 1 + atrule.name.length + (atrule.raws.afterName ?? ' ').length;
}

function classifyDeclValue(decl: Declaration, file: string, namespaces: NamespaceMap): SyntaxFinding[] {
  return classifyValue(decl.value, { file, node: decl, baseOffset: declValueOffset(decl), namespaces });
}

/** Classifies interpolation in a declaration's property name (e.g. `prop-#{$n}: v;`). One finding for the whole prop. */
function classifyPropInterpolation(decl: Declaration, file: string): SyntaxFinding {
  const spans = findInterpolationSpans(decl.prop);
  const allSimple = spans.every((span) => isSingleVariableBody(span.body));
  const position = nodeStart(decl);
  return allSimple
    ? {
        file,
        line: position.line,
        column: position.column,
        syntax: 'interpolation',
        action: { kind: 'convert', stage: 'interpolation' },
      }
    : {
        file,
        line: position.line,
        column: position.column,
        syntax: 'interpolation containing an expression',
        action: {
          kind: 'unsupported',
          milestone: 'never',
          hint: 'Interpolation containing an expression has no dialect equivalent; pre-compute the value or restructure the code so the interpolation body is a single variable.',
        },
      };
}

function handleDecl(decl: Declaration, file: string, namespaces: NamespaceMap, findings: SyntaxFinding[]): void {
  const prop = decl.prop;

  if (prop.startsWith('$')) {
    if (decl.parent?.type !== 'root') {
      pushUnsupportedAtNode(
        findings,
        file,
        decl,
        'local variable declaration',
        'M3',
        'Move the declaration to the top level, or inline the value at each use site.',
      );
      return;
    }
    if (containsFlag(decl.value, '!default')) {
      pushUnsupportedAtNode(findings, file, decl, '!default', 'never');
      return;
    }
    if (containsFlag(decl.value, '!global')) {
      pushUnsupportedAtNode(findings, file, decl, '!global', 'never');
      return;
    }
    if (isMapOrListLiteral(decl.value)) {
      pushUnsupportedAtNode(findings, file, decl, 'map/list value', 'never');
      return;
    }
    findings.push(...classifyDeclValue(decl, file, namespaces));
    return;
  }

  if (prop.startsWith('--')) {
    // Custom properties are raw text in both Sass and the dialect: only interpolation matters.
    findings.push(
      ...classifyInterpolationOnly(decl.value, { file, node: decl, baseOffset: declValueOffset(decl), namespaces }),
    );
    return;
  }

  if (prop.includes('#{')) {
    findings.push(classifyPropInterpolation(decl, file));
    findings.push(...classifyDeclValue(decl, file, namespaces));
    return;
  }

  findings.push(...classifyDeclValue(decl, file, namespaces));
}

function classifyParenArgsIfAny(atrule: AtRule, file: string, namespaces: NamespaceMap): SyntaxFinding[] {
  const extracted = extractParenArgs(atrule.params);
  if (!extracted) return [];
  const baseOffset = atRuleParamsOffset(atrule) + extracted.offset;
  return classifyValue(extracted.content, { file, node: atrule, baseOffset, namespaces });
}

/**
 * The remainder of `params` after the leading quoted specifier. Modifier clauses
 * (`as` / `show` / `hide` / `with`) can only appear there, so testing the remainder avoids
 * false positives on paths that contain those words (e.g. `@forward './as/base'`).
 */
function afterQuotedSpecifier(params: string): string {
  const trimmed = params.trim();
  const match = /^(['"])(?:\\.|(?!\1).)*\1/u.exec(trimmed);
  return match ? trimmed.slice(match[0].length) : trimmed;
}

/** `params` with the contents of its first `(...)` blanked out, so clause keywords inside string arguments are ignored. */
function outsideParenArgs(params: string): string {
  const extracted = extractParenArgs(params);
  if (!extracted) return params;
  const close = extracted.offset + extracted.content.length;
  return `${params.slice(0, extracted.offset)}${params.slice(close)}`;
}

/** Whether `@import`'s params describe a plain-CSS import (design doc §6, `@import` row). */
export function isPlainCssImport(params: string): boolean {
  const trimmed = params.trim();
  if (/^url\(/iu.test(trimmed)) return true;
  const match = /^(['"])((?:\\.|(?!\1).)*)\1/u.exec(trimmed);
  if (!match) return false;
  const specifier = match[2] ?? '';
  if (specifier.endsWith('.css')) return true;
  if (/^(https?:)?\/\//u.test(specifier)) return true;
  const rest = trimmed.slice(match[0].length).trim();
  // Trailing content after the quoted specifier that isn't a multi-import comma is a media query.
  return rest !== '' && !rest.startsWith(',');
}

function namespaceFromWrittenMixinName(params: string): boolean {
  const nameBeforeParen = params.includes('(') ? params.slice(0, params.indexOf('(')) : params;
  return /^[\w-]+\./u.test(nameBeforeParen.trim());
}

function handleAtRule(atrule: AtRule, file: string, namespaces: NamespaceMap, findings: SyntaxFinding[]): void {
  const name = atrule.name;
  const params = atrule.params;

  switch (name) {
    case 'mixin': {
      if (params.includes('...')) {
        pushUnsupportedAtNode(findings, file, atrule, 'rest arguments', 'never');
        return;
      }
      pushConvertAtNode(findings, file, atrule, '@mixin', 'mixins');
      findings.push(...classifyParenArgsIfAny(atrule, file, namespaces));
      return;
    }
    case 'include': {
      if (params.includes('...')) {
        pushUnsupportedAtNode(findings, file, atrule, 'rest arguments', 'never');
        return;
      }
      if (/\busing\b/u.test(outsideParenArgs(params))) {
        pushUnsupportedAtNode(findings, file, atrule, '@include ... using', 'never');
        return;
      }
      pushConvertAtNode(findings, file, atrule, '@include', 'mixins');
      if (namespaceFromWrittenMixinName(params)) {
        pushConvertAtNode(findings, file, atrule, 'namespaced mixin reference', 'modules');
      }
      findings.push(...classifyParenArgsIfAny(atrule, file, namespaces));
      return;
    }
    case 'content': {
      if (params !== '') {
        pushUnsupportedAtNode(findings, file, atrule, '@content with arguments', 'never');
        return;
      }
      pushConvertAtNode(findings, file, atrule, '@content', 'mixins');
      return;
    }
    case 'use': {
      if (/\bwith\s*\(/u.test(afterQuotedSpecifier(params))) {
        pushUnsupportedAtNode(findings, file, atrule, '@use ... with (configuration)', 'never');
        return;
      }
      pushConvertAtNode(findings, file, atrule, '@use', 'modules');
      return;
    }
    case 'forward': {
      if (/\b(as|show|hide|with)\b/u.test(afterQuotedSpecifier(params))) {
        pushUnsupportedAtNode(findings, file, atrule, '@forward with modifiers', 'never');
        return;
      }
      pushConvertAtNode(findings, file, atrule, '@forward', 'modules');
      return;
    }
    case 'import': {
      if (isPlainCssImport(params)) return;
      pushConvertAtNode(findings, file, atrule, '@import (Sass)', 'modules');
      return;
    }
    case 'error':
    case 'warn':
    case 'debug': {
      pushConvertAtNode(findings, file, atrule, `@${name}`, 'at-statements');
      return;
    }
    case 'if':
    case 'else':
    case 'each':
    case 'for':
    case 'while': {
      pushUnsupportedAtNode(findings, file, atrule, `@${name}`, 'never');
      return;
    }
    case 'function':
    case 'return': {
      pushUnsupportedAtNode(findings, file, atrule, `@${name}`, 'never');
      return;
    }
    case 'extend': {
      pushUnsupportedAtNode(
        findings,
        file,
        atrule,
        '@extend',
        'never',
        'Rewrite manually with `composes`, or expand the extended rule into this one — the general form of `@extend` (compound selectors, `%placeholder`) has no automatic dialect equivalent.',
      );
      return;
    }
    case 'at-root': {
      pushUnsupportedAtNode(findings, file, atrule, '@at-root', 'M3');
      return;
    }
    default: {
      const lowered = name.toLowerCase().replace(/^-\w+-/u, '');
      if (KNOWN_CSS_AT_RULES.has(lowered)) {
        findings.push(
          ...classifyValue(params, { file, node: atrule, baseOffset: atRuleParamsOffset(atrule), namespaces }),
        );
        return;
      }
      pushUnsupportedAtNode(findings, file, atrule, `unknown at-rule "@${name}"`, 'never');
    }
  }
}

function parseUseParams(params: string): { readonly specifier: string; readonly alias?: string } | undefined {
  const match = /^(['"])((?:\\.|(?!\1).)*)\1(?:\s+as\s+([\w-]+))?/u.exec(params.trim());
  if (!match) return undefined;
  return { specifier: match[2] ?? '', alias: match[3] };
}

function defaultAliasFromSpecifier(specifier: string): string | undefined {
  const base = specifier.split('/').pop();
  if (!base) return undefined;
  return base.replace(/^_/u, '').replace(/\.scss$/u, '') || undefined;
}

/** Builds the alias → module map from a file's top-level `@use` statements (design doc, "Value level" §, function classification). */
function buildNamespaceMap(root: Root): NamespaceMap {
  const map = new Map<string, ResolvedNamespace>();
  for (const node of root.nodes) {
    if (node.type !== 'atrule' || node.name !== 'use') continue;
    const parsed = parseUseParams(node.params);
    if (!parsed) continue;
    if (parsed.specifier.startsWith('sass:')) {
      const module = parsed.specifier.slice('sass:'.length);
      const alias = parsed.alias ?? module;
      if (module === 'math') map.set(alias, { kind: 'math' });
      else if (module === 'color') map.set(alias, { kind: 'color' });
      else map.set(alias, { kind: 'other-sass', module });
      continue;
    }
    const alias = parsed.alias ?? defaultAliasFromSpecifier(parsed.specifier);
    if (alias !== undefined) map.set(alias, { kind: 'user' });
  }
  return map;
}

/**
 * Walks the whole AST and classifies every Sass construct against the PostCSS-dialect
 * whitelist (design doc §6): kept-as-is constructs produce no finding, constructs handled
 * by a conversion stage produce a `convert` finding, everything else produces an
 * `unsupported` finding (fail-closed).
 */
export function classifySyntax(root: Root, file: string): SyntaxFinding[] {
  const findings: SyntaxFinding[] = [];
  const namespaces = buildNamespaceMap(root);

  root.walk((node) => {
    if (node.type === 'comment') {
      if (node.raws.inline === true) {
        pushConvertAtNode(findings, file, node, 'silent comment', 'comments');
      }
      return;
    }
    if (node.type === 'decl') {
      handleDecl(node, file, namespaces, findings);
      return;
    }
    if (node.type === 'atrule') {
      handleAtRule(node, file, namespaces, findings);
      return;
    }
    if (node.type === 'rule') {
      findings.push(...classifySelector(node, file));
    }
  });

  return findings;
}

/** Converts a `SyntaxFinding` to a `Diagnostic` for uniform reporting alongside parse diagnostics. */
export function syntaxFindingToDiagnostic(finding: SyntaxFinding): Diagnostic {
  const { file, line, column, syntax, action } = finding;
  const base = {
    file,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    syntax,
  };

  if (action.kind === 'convert') {
    const stage = findStage(action.stage);
    if (!stage) throw new Error(`Unknown stage: ${action.stage}`);
    return {
      ...base,
      milestone: stage.milestone,
      message: `convertible by the "${action.stage}" stage`,
    };
  }

  const milestone: DiagnosticMilestone = action.milestone;
  return {
    ...base,
    milestone,
    message: `"${syntax}" is not supported`,
    ...(action.hint !== undefined ? { hint: action.hint } : {}),
  };
}

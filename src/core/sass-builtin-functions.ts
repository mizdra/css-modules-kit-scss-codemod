/**
 * Data tables for classifying dart-sass builtin functions against the PostCSS-dialect
 * whitelist (design doc §6.1). Shape/branching logic lives in `classify-value.ts`; this
 * module only holds the name → category mapping.
 */

/**
 * Sass global color functions (no namespace required) that have a mapping to CSS
 * relative color syntax / `color-mix()`. Convertible by the `colors` stage.
 */
export const GLOBAL_COLOR_FUNCTIONS: ReadonlySet<string> = new Set([
  'darken',
  'lighten',
  'desaturate',
  'adjust-hue',
  'transparentize',
  'fade-out',
  'opacify',
  'fade-in',
  'adjust-color',
  'scale-color',
]);

/**
 * All other dart-sass global builtin function aliases (string/list/map/selector/meta
 * helpers and the like). None of these have a CSS counterpart, so they are always
 * unsupported (never planned).
 */
export const OTHER_GLOBAL_ALIASES: ReadonlySet<string> = new Set([
  'blue',
  'green',
  'red',
  'hue',
  'saturation',
  'lightness',
  'complement',
  'change-color',
  'ie-hex-str',
  'append',
  'index',
  'is-bracketed',
  'join',
  'length',
  'list-separator',
  'nth',
  'set-nth',
  'zip',
  'map-get',
  'map-has-key',
  'map-keys',
  'map-merge',
  'map-remove',
  'map-values',
  'comparable',
  'percentage',
  'random',
  'unit',
  'unitless',
  'call',
  'content-exists',
  'feature-exists',
  'function-exists',
  'get-function',
  'global-variable-exists',
  'inspect',
  'keywords',
  'mixin-exists',
  'type-of',
  'variable-exists',
  'is-superselector',
  'selector-append',
  'selector-extend',
  'selector-nest',
  'selector-parse',
  'selector-replace',
  'selector-unify',
  'simple-selectors',
  'quote',
  'str-index',
  'str-insert',
  'str-length',
  'str-slice',
  'to-lower-case',
  'to-upper-case',
  'unique-id',
  'unquote',
]);

/**
 * Sass global math functions (no namespace required) that map to a CSS math function:
 * `ceil()` → `round(up, ...)`, `floor()` → `round(down, ...)`. Convertible by the
 * `expressions` stage. Unlike global `abs`/`min`/`max`/`round`, which are dual CSS
 * names and pass through unchanged, these two have no same-name CSS counterpart.
 */
export const GLOBAL_MATH_FUNCTIONS: ReadonlySet<string> = new Set(['ceil', 'floor']);

/** `sass:math` functions that map to a CSS math function. Convertible by the `expressions` stage. */
export const MATH_MODULE_FUNCTIONS: ReadonlySet<string> = new Set([
  'div',
  'mod',
  'abs',
  'min',
  'max',
  'clamp',
  'round',
  'ceil',
  'floor',
  'pow',
  'sqrt',
  'hypot',
  'log',
  'exp',
  'sign',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
]);

/** `sass:color` functions that map to CSS relative color syntax / `color-mix()`. Convertible by the `colors` stage. */
export const COLOR_MODULE_FUNCTIONS: ReadonlySet<string> = new Set(['adjust', 'scale', 'mix']);

/** Dual CSS/Sass color function names whose CSS vs. Sass meaning is disambiguated by argument shape. */
export const RGB_HSL_FUNCTIONS: ReadonlySet<string> = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

/**
 * CSS math functions (Values and Units Level 4) that dart-sass treats as "special
 * functions": their contents are parsed as plain CSS math, not SassScript, so
 * arithmetic operators inside them (`calc($gap * 2)`) are literal CSS, not Sass
 * arithmetic, and require no conversion. This is distinct from the namespaced
 * `math.*` functions (e.g. `math.min`), whose arguments ARE full SassScript
 * expressions evaluated eagerly by Sass.
 */
export const CSS_MATH_FUNCTIONS: ReadonlySet<string> = new Set([
  'calc',
  'min',
  'max',
  'clamp',
  'mod',
  'rem',
  'round',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'pow',
  'sqrt',
  'hypot',
  'log',
  'exp',
  'abs',
  'sign',
]);

/** Sass color functions whose single-argument form is plain CSS (filter), rejected only when it isn't a plain literal. */
export const FILTER_SHAPED_COLOR_FUNCTIONS: ReadonlySet<string> = new Set(['invert', 'opacity', 'grayscale']);

/**
 * Whether a bare (non-namespaced) function name is a Sass-evaluated builtin: dart-sass
 * computes the call to a value at compile time, so an adjacent `/` is Sass division.
 * CSS whitelist functions (`var`, `calc`, ...) and unknown functions are NOT included —
 * dart-sass passes the slash through untouched when the operands aren't Sass numbers.
 */
export function isSassEvaluatedFunctionName(nameLower: string): boolean {
  return (
    GLOBAL_COLOR_FUNCTIONS.has(nameLower) ||
    GLOBAL_MATH_FUNCTIONS.has(nameLower) ||
    OTHER_GLOBAL_ALIASES.has(nameLower) ||
    nameLower === 'mix' ||
    nameLower === 'if'
  );
}

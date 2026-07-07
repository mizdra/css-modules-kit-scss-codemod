# Scss → CSS 移行ツール (`@css-modules-kit/scss-codemod`) 設計書

- Status: 実装中 (M0。進捗は [§13.2](#132-実装チェックリスト-m0) を参照)
- 対象リポジトリ: `mizdra/css-modules-kit-scss-codemod` (独立リポジトリ)
- パッケージ名: `@css-modules-kit/scss-codemod`
- 最終更新: 2026-07-07

## 1. 概要

CSS Modules Kit (CMK) は Sass をサポートしていない。既存の `.module.scss` 資産を `.module.css` へ移行するための一度きりの codemod ツールを提供する。

CSS は描画に直結するため、**移行の安全性を最重視する**。全機能の自動変換よりも、「対応範囲は狭いが、範囲外を確実に拒否し、黙って壊れない」codemod を優先する。**false success (誤変換して成功と報告すること) を最も避ける**。

### ツールの分割

移行は 2 つのツールの分担で行う。本設計書が扱うのは scss-codemod のみ:

```
.module.scss ──[scss-codemod]──▶ .module.css (PostCSS 方言) ──[css-codemod (将来の別ツール)]──▶ plain CSS
```

- **scss-codemod**: SCSS を、**postcss-simple-vars + postcss-mixins + postcss-nested で処理できる CSS** (以下「PostCSS 方言」。[§4](#4-変換先-postcss-方言)) へ変換する。SCSS と PostCSS 方言は構文がほぼ重なるため、変換は薄い構文写像に留まり、責務が最小になる。
- **css-codemod** (将来の別ツール): css → css の変換を担う。PostCSS 方言から plain CSS への変換 (`$var` → custom property、mixin → `@custom-media` / 展開、Sass 風ネスト → native CSS nesting) は、CSS になってからでもできることなので、すべてこちらの責務とする ([§12](#12-css-codemod-との境界))。

この分割により、scss-codemod のスコープが明確になり、将来 less-codemod を作る場合も「less → PostCSS 方言」の最小の変換だけ書けば css-codemod を共有できる。

### 前提

- 対象は SCSS 記法のみ。インデント記法 (`.sass`) は対象外
- 対象コードは dart-sass でコンパイルできる (できないファイルは analyze が報告する)
- ユーザは bundler と minifier を使っている (CSS Modules は bundler とセットで使うものであるため)。たとえば「`//` → `/* */` 変換でコメントが CSS 出力に残る」ような差分は minify で消えるため安全とみなす
- 変換後、ユーザのビルドは Sass から PostCSS プラグイン列 (postcss-mixins → postcss-simple-vars → postcss-nested。古いブラウザをサポートする場合は後段に postcss-preset-env を追加。[§6.1](#61-式関数の-css-への写像)) に切り替わる。設定の書き換え自体はユーザに一任し、ツールは案内のみ出力する

## 2. ゴール / 非ゴール

### ゴール

- `.module.scss` を PostCSS 方言の `.module.css` へ変換する。Sass が担っていた共通化 (変数・mixin・ネスト) は方言側の同等機能でそのまま維持される
- 変換する構文と対象 glob をユーザが選択し、構文ごとに対象範囲へ一括適用できる (段階的な変換)。各段階の diff を git で人間がレビューできる
- 変換全体を end-to-end で機械検証できる: 「dart-sass (変換前)」と「PostCSS プラグイン列 + CSS 値評価 (変換後)」という 2 つの機械的な評価器の出力を比較する ([§10](#10-verify-の設計))
- 変換できない箇所を洗い出し、人間や Coding Agent が修正するためのヒントを出力する ([§11 todo](#11-todo-変換できない箇所の洗い出し))

### 非ゴール

- plain CSS への変換 (custom property 化・`@custom-media` 化・native CSS nesting 化)。css-codemod の責務 ([§12](#12-css-codemod-との境界))
- dart-sass のコンパイル出力をそのままソースファイルに昇格させる機能 (いわゆる compile-through)。変換できないファイルの扱いは todo コマンドの出力 + 人間/Coding Agent による修正に一本化する
- ビルドパイプラインへの常駐 (一度きりの移行ツール)
- 変換前コードをコメントで残す注釈機能 (変換前後の対応は git diff で追う)
- 「変換前後で export されるトークン集合が同じか」の検証
- `@value` (ICSS) を変換先にすること (Lightning CSS が [公式に unsupported と明記](https://lightningcss.dev/css-modules.html)しているため)

## 3. 設計指針

1. **安全な変換**。変換対象として定義された構文の一覧 ([§6](#6-対応する-sass-構文) の表) に載っている構文だけを変換し、載っていない構文は — 一見無害に見えても — 素通しせずエラーにする (whitelist 方式・fail-closed)。Sass の値の意味論は再実装しない: 式や関数は codemod が値を計算するのではなく CSS の対応物へ写像し ([§6.1](#61-式関数の-css-への写像))、計算は既存の評価器 (Sass ビルド・ブラウザ・minifier・verify) に任せる。
2. **コーディングスタイルの保持**。共通化のためのコード (変数・mixin・ネスト) は共通化を維持したまま変換する。PostCSS 方言は SCSS と構文がほぼ同じため、`$var`・ネストは原則無変換で保持され、mixin もキーワードの書き換えだけで済む。整形・コメントは postcss-scss の raws で保持する。`&` 連結 (`&_bar` 等) も無変換で保持する (脱糖は css-codemod の責務。[§12](#12-css-codemod-との境界))。
3. **段階的な変換**。変換する項目を構文単位 (= stage 単位) でユーザが選択し、ユーザが glob で指定した対象ファイルへ一括適用する。1 stage = 1 commit で同質な diff をレビューできる。安全性の区分は選択の括りではなく、analyze が表示するラベルとする。

適用単位を「1 ファイルずつ」ではなく「stage ごとに対象範囲へ一括」とするのは、複数ファイルを解析しないと変換方式が定まらない変換 (名前の衝突検査、partial と consumer の同時書き換え) があるため。対象範囲への一括適用でも stage は個別に選べるので、段階的な変換は維持される。

## 4. 変換先: PostCSS 方言

変換先は次の 3 プラグインで plain CSS へ評価できる CSS とする。いずれも postcss org / メンテ継続中 (週間 DL: postcss-nested 5,300 万、postcss-simple-vars 150 万、postcss-mixins 100 万):

| プラグイン                                                            | 担当   | SCSS との対応                                                                                                                                                               |
| --------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [postcss-simple-vars](https://github.com/postcss/postcss-simple-vars) | 変数   | `$var: v;` 宣言・`$var` 参照とも**同一構文**。interpolation は `#{$x}` → `$(x)` で、値・セレクタ・at-rule params・プロパティ名のすべてで使える (実験で確認)。演算機能はない |
| [postcss-mixins](https://github.com/postcss/postcss-mixins)           | mixin  | 定義 `@mixin f` → `@define-mixin f`、適用 `@include f` → `@mixin f`、`@content` → `@mixin-content` のキーワード写像。引数・default 値も対応                                 |
| [postcss-nested](https://github.com/postcss/postcss-nested)           | ネスト | Sass 互換のテキスト結合意味論。`&:hover` も at-rule bubbling も**無変換**で通る (実験で確認)                                                                                |

プラグインの適用順は **postcss-mixins → postcss-simple-vars → postcss-nested** (postcss-mixins README: "you must set this plugin before postcss-simple-vars and postcss-nested")。

検証済みの事実 (2026-07-06 の実験。[§14](#14-参考一次情報)):

- postcss-mixins にとって postcss-nested は**ハード依存ではない** (dependencies に含まれず、README も「一緒に使える」と述べるのみ)。ただし mixin 本体がネストを含む場合、postcss-mixins 自体はネストを展開しないため、後段にネスト展開プラグインが事実上必要。
- **postcss-nesting (CSS 標準準拠) は `&_bar` のような連結セレクタを壊す** (`&-suffix` を型セレクタとの複合と解釈し `-suffix.baz` を出力する)。Sass から来たコードのネストの受け皿は postcss-nested でなければならない。
- postcss-simple-vars で「プロパティ名全体が変数」の場合は `$(prop): 10px` 形式が必須 (素の `$prop: 10px` は変数の再宣言と解釈され除去される)。interpolation の写像規則に組み込む。
- `calc($gap * 2)` は simple-vars の置換後 `calc(8px * 2)` という valid CSS になる (演算は browser / minifier が行う)。

## 5. アーキテクチャ

### 5.1 パーサー構成

| 役割                                     | 採用技術                                                                                          | 理由                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| source-to-source 変換の基盤 (AST + raws) | **postcss-scss**                                                                                  | raws (整形情報) を保持し、stylelint が採用する実績がある                                                 |
| module specifier の解決                  | **bundler-compatible resolver (`enhanced-resolve` または `oxc-resolver`)**                        | bundler に近い解決規則で `@use`・`@forward`・Sass `@import` の参照先を canonicalize する                 |
| verify の変換前側の評価器                | **dart-sass (npm `sass`) の JS API**                                                              | reference implementation。`compileString()` ([JS API docs](https://sass-lang.com/documentation/js-api/)) |
| verify の変換後側の評価器                | **postcss-mixins + postcss-simple-vars + postcss-nested** + CSS 値評価 ([§10](#10-verify-の設計)) | 変換先方言の意味論そのもの                                                                               |

**sass-parser (dart-sass 公式の PostCSS 互換パーサー) は不採用**。npm README に "not yet suitable for production use (...) does not yet support parsing raws (...) unsuitable for certain source-to-source transformations" と明記されているため ([npm: sass-parser](https://www.npmjs.com/package/sass-parser))。

dart-sass、resolver、各 postcss プラグインは dependencies (`^x.y.z`) に持ち、実際に解決されたバージョンをレポートに記録する。

module graph は、対象 glob に含まれる各ファイルの AST から `@use`・`@forward`・Sass `@import` を抽出し、bundler-compatible resolver で specifier を解決して importer から imported への edge を構築する。resolver の実装と設定はレポートに記録する。対象 glob の範囲外、`--exclude` に一致する、または `node_modules` 配下にある参照先は graph 上に存在しないものとして無視し、そのファイルを解析・変換しない。

specifier の解決順は (1) importer からの相対解決 → (2) bare specifier (`./`・`../`・`/` で始まらない) のみ node_modules 解決 → (3) `--load-path <dir>` で指定した各ディレクトリからの解決、で first-match-wins とする。この順序は Sass JS API の current importer → importers → loadPaths の解決順に対応する ((2) は、scss-codemod のユーザは bundler を使う前提であるため、sass-loader などの bundler 連携 importer と同様に node_modules からも解決するもの)。node_modules 解決は oxc-resolver の `modules: ['node_modules']`・`mainFields: ['sass', 'style']`・`conditionNames: ['sass', 'style']` (sass-loader の enhanced-resolve 設定に準拠) で行い、通常の candidate に加えて raw specifier そのもの (`@use 'pkg'` → package.json の sass/style field 経由) も試す。解決結果が `.scss`/`.css` で終わらない場合は match とみなさない (fail-closed)。`--load-path` は dart-sass の loadPaths 相当。

### 5.2 値の形の静的検査

codemod は値を評価しないが、変換の適用条件の判定に「値の形」が必要な場面がある (例: 除算 `math.div($a, $b)` を `calc($a / $b)` へ写像してよいのは除数が unitless number のときだけ)。この判定は、**対象変数のすべてのトップレベル宣言の値リテラルを構文的に検査する**ことで行う (評価はしない)。宣言値がリテラルでない・形が確認できない場合は fail-closed でエラーにする。

## 6. 対応する Sass 構文

表にない構文はすべて**エラー** (whitelist 方式なので、この表が whitelist の定義そのもの)。「M2 で対応予定」は「初期実装ではエラーにし、マイルストーン M2 ([§13](#13-実装優先順位)) で変換に対応する」の意。エラーになった構文は todo ([§11](#11-todo-変換できない箇所の洗い出し)) の出力対象になる。

| Sass 構文                                                                          | 扱い                                                                                                                                                                                                                                                                          | 対応時期     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| ネスト (`&:hover`、at-rule bubbling)                                               | **無変換** (postcss-nested が Sass 互換のため)                                                                                                                                                                                                                                | —            |
| `&_bar` のような連結セレクタ (`&` + 識別子の連結)                                  | **無変換** (postcss-nested が Sass 互換のテキスト結合で処理する。[§4](#4-変換先-postcss-方言))。脱糖は css-codemod の責務 ([§12](#12-css-codemod-との境界))。連結のままでは CMK がクラス名を認識できないため、CMK の導入は css-codemod での脱糖後になる                       | —            |
| トップレベル `$var` 宣言 (再代入含む) と参照                                       | **無変換** (同一構文。トップレベルの逐次的な再代入は simple-vars も同じ意味論で、差分があれば verify が検出する)                                                                                                                                                              | —            |
| map / list 値の変数宣言 (`$colors: (...)`)                                         | エラー (方言・CSS に対応物がない。todo 対象)                                                                                                                                                                                                                                  | 対応予定なし |
| `/* */` (loud comment)                                                             | そのまま                                                                                                                                                                                                                                                                      | —            |
| `//` (silent comment)                                                              | `/* */` へ変換 (minifier が削除する前提で許容)                                                                                                                                                                                                                                | M0           |
| `@error` / `@warn` / `@debug`                                                      | 除去 (内容はログに記録)。compile-time 専用の構文で CSS 出力を生まない。`@error` に到達するコードならそもそもコンパイルが失敗し analyze が報告する                                                                                                                             | M0           |
| 演算・math 系関数                                                                  | `calc()` / CSS math functions へ写像 ([§6.1](#61-式関数の-css-への写像))                                                                                                                                                                                                      | M1           |
| 色関数                                                                             | relative color syntax / `color-mix()` へ写像 ([§6.1](#61-式関数の-css-への写像))                                                                                                                                                                                              | M2           |
| 上記以外の関数呼び出し (文字列系・list/map 系・`meta.*`・`if()`・`unique-id()` 等) | エラー (CSS に対応物がない。todo 対象)                                                                                                                                                                                                                                        | 対応予定なし |
| ユーザー定義 `@function`                                                           | エラー (todo 対象)                                                                                                                                                                                                                                                            | 対応予定なし |
| `@use` / `@forward` (修飾なし) / Sass `@import`                                    | `@import '<path>.css'` へ変換し、namespace 参照 (`t.$x` → `$x`) を剥がす。異なる module が公開する同名 symbol は値にかかわらず衝突とし、module path 由来の決定的な prefix を付ける                                                                                            | M1           |
| interpolation `#{$x}`                                                              | `$(x)` へ写像 (値・セレクタ・プロパティ名・at-rule params すべて対応)。式を含む interpolation (`#{$a + $b}`) はエラー (todo 対象)                                                                                                                                             | M2           |
| `@mixin` / `@include` / `@content`                                                 | `@define-mixin` / `@mixin` / `@mixin-content` へキーワード写像。引数 `($a, $b: 1px)` → ` $a, $b: 1px`。rest 引数 (`$args...`) はエラー                                                                                                                                        | M2           |
| `@use` — 参照先が style-emitting partial                                           | `@import` へ変換 (bundler ごとの意味論差を警告付きで。[§9.3](#93-import-の-bundler-意味論調査結果))                                                                                                                                                                           | M2           |
| ルール内ローカル `$var` 宣言                                                       | エラー。Sass の block scope と simple-vars の逐次置換で意味論が異なるため、等価になる条件を詰めてから対応を検討する                                                                                                                                                           | M3           |
| `@at-root`                                                                         | エラー。対応を検討                                                                                                                                                                                                                                                            | M3           |
| `!default` / `!global` / flow-control scope                                        | エラー (simple-vars に対応物がない。todo 対象)                                                                                                                                                                                                                                | 対応予定なし |
| `@use ... with ()` (configuration)                                                 | エラー (方言に対応物がない。todo 対象)                                                                                                                                                                                                                                        | 対応予定なし |
| 制御構文 (`@if` / `@each` / `@for` / `@while`)                                     | エラー (todo 対象)                                                                                                                                                                                                                                                            | 対応予定なし |
| `@extend` / placeholder selector (`%foo`)                                          | エラー (todo 対象)。`composes` への自動変換はしない: `@extend` の一般形 (複合セレクタや `%placeholder` への extend) は `composes` で表現できず、`composes` は styles オブジェクト経由でクラス名を得た要素にしか効かないため、等価な置換になるかはコードごとに人間の判断が要る | 対応予定なし |
| インデント記法 (`.sass`)                                                           | 対象外                                                                                                                                                                                                                                                                        | 対応予定なし |

### 6.1 式・関数の CSS への写像

式・関数は値を計算せず、CSS の対応物へ写像する。写像表 (whitelist):

| Sass                                                                               | CSS                                                               | 備考                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$a + $b` / `$a - $b` / `$a * $b`                                                  | `calc($a + $b)` 等                                                | `*` は少なくとも一方が unitless number                                                                                                                                                                                                                                                                             |
| `math.div($a, $b)`、`$a / $b`                                                      | `calc($a / $b)`                                                   | 除数が unitless number のときのみ ([§5.2](#52-値の形の静的検査))。単位付き除算 (`math.div(10px, 2px)` → unitless) は CSS に安全な対応物がなくエラー                                                                                                                                                                |
| `math.mod` / `math.abs` / `math.min` / `math.max` / `math.clamp` / `math.round` 等 | `mod()` / `abs()` / `min()` / `max()` / `clamp()` / `round()`     | CSS math functions                                                                                                                                                                                                                                                                                                 |
| `math.ceil` / `math.floor` (global の `ceil()` / `floor()` 含む)                   | `round(up, ...)` / `round(down, ...)`                             | CSS `round()` の rounding strategy で表現                                                                                                                                                                                                                                                                          |
| `darken($c, 10%)` / `lighten($c, 10%)`                                             | `hsl(from $c h s calc(l - 10))` / `calc(l + 10)`                  | relative color syntax (RCS)。チャンネル (`l`・`s`) は number に解決されるため percentage のままでは無効 (実験で確認)。amount 引数は数値リテラルへ変換して埋め込む。amount が変数の場合はエラー (todo 対象)                                                                                                         |
| `saturate` / `desaturate` / `adjust-hue`                                           | `hsl(from $c h calc(s ± 10) l)` / `hsl(from $c calc(h + 30) s l)` | RCS。amount の扱いは darken と同じ                                                                                                                                                                                                                                                                                 |
| `rgba($c, $a)` / `transparentize` / `opacify`                                      | `rgb(from $c r g b / ...)`                                        | RCS。2 引数形は構文分類 (core/classify) が引数の形で colors 対象に分類するが、`rgba(var(--rgb), 0.5)` のような plain CSS の 2 引数形 (custom property トリック) も紛れ込む。**colors stage の precondition で第 1 引数が `$var` か色リテラルであることを検査し、それ以外 (`var()` 等) は変換せずエラーにすること** |
| `color.adjust` / `color.scale`                                                     | RCS + `calc()`                                                    | scale は残余比率の calc で表現                                                                                                                                                                                                                                                                                     |
| `color.mix($a, $b, $w)`                                                            | `color-mix(in srgb, $a $w, $b)`                                   | 一般形は変換しない。引数が静的に評価可能な対応色形式であり、変換前後の評価結果が正規化後に strict 一致する場合のみ変換する。それ以外はエラー (todo 対象)                                                                                                                                                           |

写像に伴う性質:

- **Sass ビルドとの互換**: dart-sass は `calc()`・CSS math functions を静的に評価し (`mod(10px, 3px)` → `1px`)、RCS・`color-mix()` は変数を解決した上で素通しする (実験で確認。[§14](#14-参考一次情報))。したがって写像後も Phase 1 ([§8.2](#82-2-フェーズ構造)) の Sass ビルドは動き続ける。
- **古いブラウザのサポート**: postcss-simple-vars はビルド時置換なので、プラグイン列の後段に [postcss-preset-env](https://github.com/csstools/postcss-plugins/tree/main/plugin-packs/postcss-preset-env) を足せば、置換後に静的になった RCS / `color-mix()` / `mod()` を古いブラウザ向けの値へコンパイルできる (実験で確認: `color-mix(in srgb, #336699 50%, white)` → `rgb(153, 179, 204)`、`hsl(from #336699 h s calc(l - 10))` → `rgb(38, 77, 115)` = Sass の `darken(#336699, 10%)` と一致)。preset-env を足さない場合は素の RCS 等がそのまま配信されるため、baseline 2024 相当のブラウザ要件が生じる。どちらにするかはユーザの選択で、`colors` stage の適用時に案内を出す。
- 写像表にない関数 (文字列系・list/map 系・`if()`・`unique-id()` 等) は CSS に対応物がないためエラー (todo 対象)。

## 7. CLI 設計

```
cmk-scss-codemod analyze <patterns...> [--exclude <pattern>...] [--load-path <dir>...] [--json]
cmk-scss-codemod convert <stage> <patterns...> [--exclude <pattern>...] [--load-path <dir>...]
                                      # stage: comments | at-statements | expressions | colors |
                                      #        modules | mixins | interpolation | to-css
cmk-scss-codemod verify <patterns...> [--exclude <pattern>...] [--load-path <dir>...] [--against <git-rev>]
cmk-scss-codemod todo <patterns...> [--exclude <pattern>...] [--load-path <dir>...] [--json]
```

- **対象範囲**: 1 つ以上の glob を位置引数で受け取る (例: `cmk-scss-codemod convert modules "**/*.module.scss"`)。`--exclude` は複数指定でき、一致したファイルを明示的に除外する。`node_modules` 配下は指定 glob に一致しても常にデフォルトで除外する。対象 glob の範囲外にあるファイルは module graph の構築時にも存在しないものとして無視する。
- **`analyze`**: 変換せず分析だけ行う。コンパイル不能ファイル、stage × ファイルの適用可否と安全性ラベル、module graph と partial の分類、生成名 (namespace 剥がし後の変数名・mixin 名) の横断衝突検査、todo 対象の列挙。
- **`convert <stage>`**: 指定した stage を glob で選択した対象範囲へ一括適用する ([§8](#8-stage-の設計))。順序制約に違反する指定はエラー。機械検証つきの stage は変換前後の dart-sass 出力比較を自動実行し、不一致なら書き込まず中断する。
- **`verify`**: end-to-end の differential comparison ([§10](#10-verify-の設計))。
- **`todo`**: 変換できない箇所の洗い出しと修正ヒントの出力 ([§11](#11-todo-変換できない箇所の洗い出し))。

書き込みの挙動: git working tree の状態は確認しない。全対象ファイルの precondition 検査、変換、stage 固有の検証をメモリ上で完了してから、全件が成功した場合のみ書き込む。1 件でも失敗した場合は一切書き込まない。保存は同一ディレクトリの一時ファイルを経由して置換し、途中の I/O エラー時は保持した元内容から best-effort でロールバックする。プレビューは `git diff`、取り消しは `git restore` で行う。

## 8. Stage の設計

### 8.1 stage 一覧

| #   | stage           | 変換                                                                                                                                                                | 安全性                                                                                                  | Phase |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `comments`      | `//` → `/* */`                                                                                                                                                      | 構築的に等価 (minifier 前提)                                                                            | 1     |
| 2   | `at-statements` | `@error` / `@warn` / `@debug` を除去 (内容はログへ)                                                                                                                 | 構築的に等価                                                                                            | 1     |
| 3   | `expressions`   | 演算・math 系関数を `calc()` / CSS math functions へ写像                                                                                                            | **機械検証つき** (dart-sass が静的に評価し出力が変わらないため、変換前後の出力比較で自動検証)           | 1     |
| 4   | `colors`        | 色関数を RCS / `color-mix()` へ写像                                                                                                                                 | 移し替え (end-to-end verify で検証)。適用時からブラウザ要件が生じる ([§6.1](#61-式関数の-css-への写像)) | 1     |
| 5   | `modules`       | `@use`/`@forward`/Sass `@import` → `@import '<path>.css'`、namespace 参照の剥がし (`t.$x` → `$x`、`@include t.f` → `@include f`)、衝突時のみ prefix 付与            | 移し替え (end-to-end verify で検証)                                                                     | 2     |
| 6   | `mixins`        | `@mixin`→`@define-mixin`、`@include`→`@mixin`、`@content`→`@mixin-content`、引数構文の写像                                                                          | 移し替え (同上)                                                                                         | 2     |
| 7   | `interpolation` | `#{$x}` → `$(x)`                                                                                                                                                    | 移し替え (同上)                                                                                         | 2     |
| 8   | `to-css`        | precondition (残存 Sass 専用構文ゼロ) の検査 → `.module.scss`→`.module.css`・`_x.scss`→`x.css` リネーム → TS/JS の import specifier 書き換え → ビルド設定切替の案内 | 移し替え (最終 stage)                                                                                   | 2     |

変数とネスト (`&` 連結含む) は無変換なので stage が存在しない。

### 8.2 2 フェーズ構造

stage は「その適用後もプロジェクトが Sass でビルドできるか」で 2 つの Phase に分かれる:

- **Phase 1 (`comments`, `at-statements`, `expressions`, `colors`)**: 出力が Sass 互換のまま。stage ごとに独立して merge・デプロイできる。
- **Phase 2 (`modules`, `mixins`, `interpolation`, `to-css`)**: PostCSS 方言の構文 (`@mixin f` の適用構文、`$(x)` 等) は Sass でビルドできないため、**この Phase 全体が 1 つのカットオーバー PR** になる (stage ごとの commit でレビュー可能性は維持)。`to-css` 完了時にビルド設定を Sass から postcss-mixins → postcss-simple-vars → postcss-nested へ切り替え、直後に `verify` を実行する。

順序制約: `modules` は `mixins`/`interpolation` より前 (namespace 剥がしが先に済んでいないと `$(t.$x)` のような不正な写像が生まれる)。`comments`/`at-statements` は任意の時点で実行できる。

### 8.3 precondition 検査とエラー処理

すべての stage は precondition 検査を持ち、検査と変換の関係は全 stage で対称である:

- 各 stage の precondition は「自分が扱う構文が変換可能な形をしていること」(例: `expressions` なら除数が unitless number であること)。満たさない場合はエラー。
- `to-css` の precondition は「全 stage の変換が完了し、変換先 PostCSS 方言の専用 validator に合格すること」。validator は許可された変数宣言・参照、mixin、ネスト、at-rule、import だけが存在し、Sass 専用構文が残っていないことを whitelist 方式で検査する。標準の postcss (非 scss) でパースできることだけでは適合と判定しない。さらに実際の PostCSS プラグイン列を実行し、その出力が標準 CSS としてパースできることを確認する。
- 未対応構文の**発見**は stage の実行を待たず、`analyze` / `todo` がいつでも対象範囲を横断して行える。stage 実行時のエラーはあくまで書き込み前の安全装置。

stage の適用は対象範囲全体でアトミックとする。対象ファイルの診断収集は最後まで続行するが、precondition、変換、検証のいずれかが 1 件でも失敗した場合は、変換可能だったファイルを含めて一切書き込まない。エラーは位置 + 構文名 + 回避策とともに報告する。修正後に同じ stage を再実行でき、各 stage は冪等とする。

## 9. Module システムの変換

### 9.1 partial の検出と分類

**partial** とは、アンダースコアで始まるファイル名 (例: `_theme.scss`) を持ち、Sass の specifier で拡張子と先頭のアンダースコアを省略して参照できる部品ファイルのこと。単体でコンパイル可能かどうかは分類条件にしない。analyze は対象 glob に含まれるファイルだけを解析し、AST から抽出した import 系構文の specifier を bundler-compatible resolver で解決して module graph と consumer を特定する。対象範囲外の参照先は graph 上に存在しないものとして無視する。

分類 (CSS 出力の有無ではなく AST のトップレベルノード種別で判定する。変数だけに見える partial が mixin / function を持ち得るため):

| 分類                | 判定                                                                 | 扱い                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **definition-only** | `$var` 宣言・`@mixin`・`@function`・`@use`・`@forward`・コメントのみ | M1 で変換。`@import` でインライン展開された定義はプラグインが消費して CSS 出力ゼロになるため、bundler が `@import` を複製しても出力は増えない |
| **style-emitting**  | style rule・CSS を出力する at-rule を含む                            | M2 で `@import` 化 (bundler 意味論の警告付き。[§9.3](#93-import-の-bundler-意味論調査結果))                                                   |
| **mixed**           | 両方を含む                                                           | エラー (todo 対象。分割方法の案内は当面実装しない)                                                                                            |

### 9.2 変換の形

```scss
/* before: _theme.scss */ /* before: button.module.scss */
$primary: #0066ff;
@use './theme' as t;
@mixin focus {
  outline: 2px solid $primary;
}
.btn {
  color: t.$primary;
  @include t.focus;
}
```

```css
/* after: theme.css */ /* after: button.module.css */
$primary: #0066ff;
@import './theme.css';
@define-mixin focus {
  outline: 2px solid $primary;
}
.btn {
  color: $primary;
  @mixin focus;
}
```

方言の module 機構は「`@import` のインライン展開 (vite 内蔵の postcss-import 等) → 展開後の AST を simple-vars / mixins が処理」。namespace の概念がないため、`modules` stage が namespace を剥がす。異なる module が公開する同名 symbol は値や定義内容にかかわらず衝突とし、対象範囲内の symbol table に基づいて定義と全参照へ prefix を付ける。prefix は対象範囲のルートからの module path から決定的に生成し、prefix 自体の衝突も再検査する。

### 9.3 @import の bundler 意味論 (調査結果)

CSS `@import` の意味論は bundler ごとに異なる。vite / turbopack のソースコードと実験で確認した事実 (2026-07-06。[§14](#14-参考一次情報)):

|                      | vite                                                                                          | turbopack                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| CSS の `@import`     | postcss-import による **importer ごとのテキストインライン展開** (実験: 4 importer → 4 回複製) | **module graph 上の独立モジュール**。チャンクグループ内で 1 回に重複排除 (= Sass `@use` 相当の load-once が `@import` 自体に組み込まれている) |
| load-once の専用構文 | ない。JS 側 `import './x.css'` のみ一意化される                                               | 不要 (上記)                                                                                                                                   |

一方、**Sass の `@use` の load-once も vite では 1 ファイルのコンパイル内にしか効かない**ことを実験とソースコードで確認した。vite は `.scss` ファイルごとに `compileStringAsync` を呼ぶため (`packages/vite/src/node/plugins/css.ts:2610`)、style-emitting partial を 3 ファイルから `@use` すると dist に 3 回複製される (単一ファイル内の `@use ... as s1; @use ... as s2;` は 1 回)。つまり:

- **vite では `@use` → `@import` 変換は現行挙動 (per-consumer 複製 + consumer ごとのハッシュ化) とほぼ同じ意味論**になる。
- turbopack では複製が 1 回になる (改善方向の変化だが cascade 上の出現位置が変わり得る)。
- definition-only partial はどちらでも影響を受けない (展開された定義はプラグインが消費し、CSS 出力がゼロのため)。

## 10. verify の設計

### 10.1 パイプライン

変換先の方言には機械的な評価器が存在するため、**変換全体を end-to-end で differential comparison できる**:

```
A (変換前) : --against <git-rev> (既定 HEAD) の .module.scss
             → dart-sass compile (expanded) → postcss parse → 正規化
B (変換後) : 現在の .module.css
             → postcss [postcss-import (per-importer インライン), postcss-mixins,
                        postcss-simple-vars, postcss-nested]
             → CSS 値評価 (calc / CSS math functions / RCS / color-mix の静的計算。
                postcss-preset-env をそのまま評価器として使う)
             → 正規化
比較        : ルール順序を保った AST 構造比較 (CSS は順序が意味を持つため順序込み)
```

B 側の「CSS 値評価」は、A 側で dart-sass がコンパイル時に計算してしまう値 (`darken(#333, 10%)` → `#262626` 等) と、B 側で実行時計算に写像された式 (`hsl(from #333 h s calc(l - 10%))`) を突き合わせるために必要になる。

CSS 値評価にはプロジェクトの Browserslist を参照せず、ツールに固定した postcss-preset-env のバージョン、browser target、feature 一覧、`preserve: false` 設定を使う。評価後に対象の `calc()`、CSS math functions、RCS、`color-mix()` が残った場合は評価不能とし、成功扱いしない。

正規化は conservative に 2 層とする。strict はコメント除去・空白正規化・空 rule 除去、tolerant は数値・色の丸め誤差の epsilon 比較・クォートの表記ゆれを扱う。結果はファイルごとに `pass` (全対象値を評価でき strict 一致)、`review-required` (tolerant でのみ一致)、`unsupported` (評価不能な値が残存)、`fail` (評価できたが不一致) のいずれかとする。`pass` 以外は exit code を非 0 とし、差分または残存値の位置を出力する。使用した dart-sass・resolver・プラグインと評価設定のバージョンを記録し、CI から再現可能にする。

実行タイミング: Phase 2 の全 stage 適用後 (カットオーバー PR の最終確認)。Phase 1 の機械検証つき stage は convert 時の前後比較で個別に検証済み。

### 10.2 verify が検出できない差分・依拠する前提

1. **bundler / minifier の存在と挙動** — `@import` の複製/重複排除 (verify は per-importer インラインを仮定 = vite / css-loader 系。turbopack では複製回数が異なる)、コメントの minify。
2. **計算の実行時化** — コンパイル時計算から実行時計算への移行に伴う、ブラウザ実装間の数値・色の精度差。verify の CSS 値評価はあくまで参照実装 1 つとの比較である。
3. **compile-time 挙動の消失** — `@warn` / `@debug` / `@error`、Sass の deprecation 警告といった検査機構は移行で失われる。
4. **export されるトークン集合の変化** — スコープ外 (要件)。
5. **正規化のバグ** — tolerant 正規化は成功判定に使わず、非等価ペアのテストコーパスでも検証する ([§13.1](#131-テスト戦略))。
6. **構造が異なるが等価なセレクタ** — fail と判定される (安全側の誤り)。

## 11. todo (変換できない箇所の洗い出し)

codemod は範囲外の構文を自動変換しない。その代わり `todo` コマンドが、**残る手作業を洗い出し、人間や Coding Agent が修正するためのヒントを出力する**:

- ファイルごとに: 変換できない構文の位置、構文名、なぜ自動変換しないのか、推奨する手動変換の方針 (例: `@each` によるユーティリティ生成 → 展開して書き下す / `@extend` → 挙動変化を理解した上で `composes` 化するか展開する / `@use ... with ()` → 値を直書きする)
- そのまま Coding Agent に渡せる markdown プロンプト形式。「修正後に `convert` を再実行すれば残りは機械変換される。最後に `verify` で確認する」というループを指示に含める
- `--json` で機械可読形式も出力する

このコマンドはあくまで情報の出力までを責務とし、修正の実行はしない。

## 12. css-codemod との境界

css-codemod は将来の別ツール・別設計書とし、ここでは境界だけ定義する。scss-codemod の出力 (PostCSS 方言) を入力に、たとえば次のような css → css の stage を持つ想定:

- `$var` (postcss-simple-vars) → custom property / インライン展開
- mixin (postcss-mixins) → `@custom-media` 化 (media-wrapper mixin)・展開
- Sass 風ネスト (postcss-nested) → native CSS nesting 化。CSS Nesting の `&` は `:is(親)` 意味論で Sass のテキスト結合と一般に等価でないため、rule 単位の等価性判定はここで行う。**`&` 連結 (`&_bar` 等) の脱糖もここで行う** (native CSS nesting は連結を表現できないため。scss-codemod は連結を無変換で通す)

なお `$var` を custom property 化すると、色関数の引数が実行時値 (`var()`) になり postcss-preset-env の静的コンパイルが効かなくなる (RCS 等のブラウザ要件が復活する)。この点は css-codemod 側の設計で考慮が要る。

scss-codemod は `&` 連結を無変換で通すため ([§6](#6-対応する-sass-構文))、**連結を使っているプロジェクトでは、CMK の導入 (トークン認識) は css-codemod が連結を脱糖した後に可能になる**。css-codemod は「PostCSS プラグイン依存を外して plain CSS に近づけたい」ユーザのための後続ステップであると同時に、CMK 導入の前提ステップという位置づけになる。

## 13. 実装優先順位

| マイルストーン   | 内容                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **M0**           | CLI 骨格、analyze (構文分類、module graph、partial 分類)、`comments`、`at-statements`、`to-css`、`todo`    |
| **M1**           | `expressions`、`modules` (definition-only partial、namespace 剥がし、衝突検査)、`verify`                   |
| **M2**           | `mixins`、`interpolation`、`colors`、style-emitting partial の `@import` 化、`@forward`                    |
| **M3**           | ルール内ローカル `$var`、`@at-root` (等価になる条件を詰めてから)                                           |
| **対応予定なし** | 制御構文、`@extend`、`!default`/`!global`、`@use ... with ()`、写像表にない関数 — いずれも todo の出力対象 |

### 13.1 テスト戦略

- **convert フィクスチャ**: `input.scss` + stage ごとの `expected`。機械検証つき stage は「expected 自体が前後比較を pass する」ことを meta assertion として自動検査。Phase 2 完了形のフィクスチャは「dart-sass(input) とプラグイン列 + CSS 値評価(expected) の出力一致」を meta assertion にする。
- **reject フィクスチャ**: `input.scss` + 期待するエラー (構文名・位置)。whitelist が緩まないことを回帰検知。
- **冪等性の property test**: 全フィクスチャ・全 stage で「2 回適用 = 1 回適用」。
- **project-level atomicity のテスト**: precondition・変換・検証・書き込みの各地点で 1 ファイルを失敗させ、対象範囲内の全ファイルが元の内容に保たれることを検査する。
- **module graph と rename のテスト**: glob・`--exclude`・`node_modules` による境界、対象範囲外への参照の無視、同名同値を含む symbol 衝突、prefix 自体の衝突、定義と全参照の一括 rename を検査する。
- **変換先方言 validator のテスト**: 標準 PostCSS parser が受理する残存 Sass 構文を reject できることと、プラグイン列の出力が標準 CSS になることを検査する。
- **verify のテスト**: strict 一致を `pass`、tolerant のみの一致を `review-required`、未評価値の残存を `unsupported`、意図的に非等価なペアを `fail` と判定できることを検査する。偽陰性の防止が信頼性の根幹なので、非等価ペアのコーパスを増やし続ける。
- dart-sass / postcss プラグインのバージョン更新は Renovate で追従し、フィクスチャで回帰検知。

### 13.2 実装チェックリスト (M0)

M0 は 3 PR に分割して実装する。1 ステップ = 1 commit、各ステップ TDD (探索 → Red → Green → Refactoring)、PR は draft で作成する。完了したステップはチェックを付け、commit hash を記録する。

実装上の決定事項:

- resolver は **oxc-resolver** (Sass の partial 慣習 `_x.scss`・拡張子省略・`_index.scss` の candidate 展開は自前実装)
- CLI の引数パースは **`node:util` の parseArgs** (依存ゼロ)
- bin 名は **`scss-codemod`**
- テストは `tests/` ではなく source と同階層 (`src/path/to/file.test.ts`) に置く
- `runCli(argv, { stdout, stderr })` は Node.js の writable stream を受け取って書き込み、exit code (number) を返す
- 「部分集合 / subset」という語はモジュール名・API に使わない。構文分類は core/classify (`classifySyntax` / `SyntaxFinding`) と呼ぶ (「Sass 部分集合」という表現が分かりにくいため。§6 のタイトルも「対応する Sass 構文」)
- 未知の関数名の分類は **CSS whitelist 方式** (fail-closed の徹底)。[css-functions-list](https://www.npmjs.com/package/css-functions-list) (stylelint の `function-no-unknown` が使用) を CSS 関数の whitelist とし、dart-sass 組み込み (global alias 全列挙 + namespace 解決) にも CSS whitelist にも該当しない関数名はエラー (todo 対象)。CSS と Sass の両義名 (`rgba`/`min`/`if`/`invert` 等) は引数の形で判別し、判別できないものはエラー

#### PR1: 基盤 + analyze (ブランチ: `m0-cli-skeleton`)

- [x] **Step 1: パッケージ準備 + CLI 骨格** — bin 追加、parseArgs によるコマンド分岐 (analyze / convert / verify / todo)、stage テーブル (名前 × マイルストーン)、exit code 規約 (0 = 成功 / 1 = 未実装・診断ありで失敗 / 2 = 使い方エラー)。全コマンドは未実装スタブ (846aa4b)
- [x] **Step 2: core/collect + core/diagnostic** — `node:fs/promises` の `glob` による glob 収集、`--exclude`、`node_modules` 常時除外。`Diagnostic` 型 (file/line/column/syntax/milestone/message/hint) と人間向け・JSON 整形 (8c8413f, 2d1ee9d)
- [x] **Step 3: core/parse** — postcss-scss ラッパ。パース失敗の Diagnostic 化。postcss / postcss-scss を dependencies に追加 ([§5.1](#51-パーサー構成)) (26ac783)
- [x] **Step 4: core/classify (構文分類 = whitelist 判定)** — AST 走査で各ノード・値を [§6](#6-対応する-sass-構文) の表に分類 (無変換 OK / stage で変換 / エラー = todo 対象)。値の中の検査は postcss-value-parser。reject フィクスチャで回帰検知 (c67d801)
- [x] **Step 5: core/resolve + core/module-graph** — `@use`/`@forward`/Sass `@import` の specifier 抽出 → Sass candidate 展開 → oxc-resolver で解決 (相対 → bare specifier の node_modules → `--load-path` の順)。対象 glob 範囲外・`--exclude` 一致・`node_modules` 配下の参照先は無視 ([§5.1](#51-パーサー構成)) (853a55e)
- [ ] **Step 6: core/partial** — partial 分類 (definition-only / style-emitting / mixed。[§9.1](#91-partial-の検出と分類))
- [ ] **Step 7: core/sass-compile** — dart-sass (`sass` を dependencies に追加) の compileAsync ラッパ。root ファイル (非 partial) のコンパイル可否を判定
- [ ] **Step 8: commands/analyze 統合** — Step 2–7 を組み合わせ、人間向け出力と `--json` を実装。project fixture (複数ファイル構成) による e2e テスト

#### PR2: Phase 1 stages

- [ ] **Step 9: core/write** — アトミック書き込み (メモリ上で全件成功 → 同一ディレクトリの temp file 経由で置換 → I/O エラー時は best-effort ロールバック。[§7](#7-cli-設計))。atomicity のテスト ([§13.1](#131-テスト戦略))
- [ ] **Step 10: `comments` stage** — `//` → `/* */` (postcss-scss の inline comment)。コメント内に `*/` を含む場合の扱いをテストで固定
- [ ] **Step 11: `at-statements` stage** — `@error`/`@warn`/`@debug` を除去し、内容をログへ
- ~~**Step 12: `nesting` stage**~~ — 方針転換により削除 (2026-07-07)。`&` 連結の脱糖は css-codemod の責務とし、scss-codemod は連結を無変換で通す ([§6](#6-対応する-sass-構文)、[§12](#12-css-codemod-との境界))

#### PR3: to-css + todo

- [ ] **Step 13: dialect-validator** — 変換先 PostCSS 方言の whitelist 検査 + プラグイン列 (postcss-mixins → simple-vars → nested) の実行結果が標準 CSS としてパースできることの確認 ([§8.3](#83-precondition-検査とエラー処理))
- [ ] **Step 14: `to-css` stage** — precondition (Step 13 に合格) → `.module.scss`→`.module.css`・`_x.scss`→`x.css` リネーム → TS/JS の import specifier 書き換え → ビルド設定切替の案内
- [ ] **Step 15: `todo` コマンド** — 変換できない箇所の位置・構文名・理由・手動変換ヒントを markdown プロンプト形式と `--json` で出力 ([§11](#11-todo-変換できない箇所の洗い出し))

## 14. 参考一次情報

設計の根拠にした一次情報。事実は 2026-07-06 に一次情報・実験で検証した。

- **sass-parser**: [npm: sass-parser](https://www.npmjs.com/package/sass-parser) — production 不適・raws 未対応の警告。リポジトリは [sass/dart-sass の `pkg/sass-parser`](https://github.com/sass/dart-sass)。
- **Lightning CSS の `@value` 非対応**: [CSS Modules – Lightning CSS](https://lightningcss.dev/css-modules.html)、[parcel-bundler/lightningcss#659](https://github.com/parcel-bundler/lightningcss/issues/659)。
- **dart-sass JS API**: [compileString](https://sass-lang.com/documentation/js-api/functions/compilestring/)、[Logger](https://sass-lang.com/documentation/js-api/interfaces/logger-1/)。
- **PostCSS 方言の検証 (自前実験、2026-07-06、postcss-mixins@12.1.2 / postcss-simple-vars@7.0.1 / postcss-nested@7.0.2 / postcss-nesting@14.0.0)**: postcss-mixins は postcss-nested のハード依存を持たない (dependencies に不在。README は順序指示 "you must set this plugin before postcss-simple-vars and postcss-nested" と "You can use it with postcss-nested" のみ)。`@mixin-content` は `@content` 相当として動作。postcss-nesting は `&-suffix` を `-suffix.baz` と解釈して壊し、postcss-nested は `.baz-suffix` に正しく連結。simple-vars の `$(x)` はセレクタ・プロパティ名・at-rule params で動作し、`$var:` 宣言は出力から除去され、演算はしない (`calc()` に包めば valid CSS)。
- **postcss-preset-env の静的評価 (自前実験、2026-07-06)**: postcss-simple-vars の置換後に postcss-preset-env (browsers: chrome >= 80 等) を通すと、`color-mix()` → `rgb(153, 179, 204)`、`rgb(from #336699 r g b / 0.5)` → `rgba(51, 102, 153, 0.5)`、`mod(10px, 3px)` → `1px`、`hsl(from #336699 h s calc(l - 10))` → `rgb(38, 77, 115)` (= dart-sass の `darken(#336699, 10%)` と同値) に静的コンパイルされる。`calc(l - 10%)` は RCS のチャンネルが number に解決されるため無効で、変換されずそのまま残る。
- **dart-sass の素通し・静的評価挙動 (自前実験、2026-07-06)**: `hsl(from $c h s calc(l - 10%))` (relative color syntax)・`color-mix(in srgb, $c 50%, white)`・`rgb(from $c r g b / 0.5)` は変数を解決した上でそのまま出力に通る。`mod(10px, 3px)` → `1px`、`calc(1 / 3)` → `0.3333333333` と CSS math functions・calc は静的に評価される。
- **vite の Sass `@use` の per-entry 複製 (ソースコード + 実験、2026-07-06、vite@a1d73a3 / 8.1.3)**: `packages/vite/src/node/plugins/css.ts` — transform フックがファイル単位で `compileCSS` を呼び (L366-373, L433)、`makeScssWorker` が 1 ファイルごとに `compileStringAsync` を実行 (L2610)。実験: `_shared.scss` を 3 つの `.module.scss` から `@use` → dist に `.shared` が 3 回複製 (ハッシュは importer ごとに別)。単一ファイル内の `@use ... as s1; @use ... as s2;` は 1 回のみ。
- **vite の CSS `@import` (ソースコード + 実験、2026-07-06)**: postcss-import による per-importer インライン展開 (css.ts L1543, L1566-1568)、build は連結のみで重複排除なし (L621, L694)。実験: 4 importer → 4 回複製。
- **turbopack の CSS `@import` (ソースコード調査、2026-07-06、vercel/next.js@901c0803)**: `turbopack/crates/turbopack-css/src/references/mod.rs` (`@import` → `ImportAssetReference` 化しルール除去)、`references/import.rs` (`ChunkingType::Parallel`)、`turbopack-core/src/chunk/chunk_group.rs` (モジュール単位の重複排除)。
- **Sass 言語仕様**: [Comments](https://sass-lang.com/documentation/syntax/comments/)、[@error](https://sass-lang.com/documentation/at-rules/error/)、[Variables](https://sass-lang.com/documentation/variables/)、[@use](https://sass-lang.com/documentation/at-rules/use/)、[@import is deprecated](https://sass-lang.com/blog/import-is-deprecated/)。
- **CMK**: [README](https://github.com/mizdra/css-modules-kit-scss-codemod/blob/main/README.md/README.md)、[AGENTS.md](https://github.com/mizdra/css-modules-kit-scss-codemod/blob/main/AGENTS.md) (トークン・all token importer の定義)。

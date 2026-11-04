# KISS Translator page runtime in Zeus

Upstream: https://github.com/fishjar/kiss-translator

Pinned release: v2.1.1 (2026-10-13)

Commit: a1279f2517bd478ef1dd93b941f9177094486cd4

License: GPL-3.0; see LICENSE. Copyright belongs to KISS Translator contributors.
Original file hashes are recorded in upstream-files.json. Zeus modifications were
made on 2026-11-04. This package and the combined Zeus build are distributed under
GPL-3.0-only; pre-existing Apache-2.0 notices remain applicable to their sources.

## Retained implementation

The upstream Translator class, translationTargets traversal, text filters,
sentence grouping, viewport scheduling, mutation invalidation, DOM insertion,
restoration, language comparison, static site rules, and sanitization are used
directly. There is no second Zeus page-recognition engine or fallback scanner.

## Host adaptations

- translator.js receives instance-scoped translate, detectLanguage, cancel,
  onLayout, onError and onRetry ports. Extension networking, storage, messaging,
  remote rules, dictionaries, arbitrary JS hooks and main-world script injection
  are not exposed. The public Zeus API exposes only bilingual HTML and stop.
- Plain-text mode sends actual text instead of HTML entities and KISS markup
  placeholders. Returned text is escaped before the retained DOMPurify path.
  Original links and formatting remain; translation text has no copied inline
  links or rich markup. Code, math and editable controls are excluded.
- The existing wrapper ownership WeakMap is exported for source-element anchors.
  Zeus source-context extraction omits translation and annotation UI.
- DOMContentLoaded and delayed processing cannot restart a stopped instance.
  Source CSS, including an inline div in PMLR's byline, takes precedence over tag
  defaults. Relevant attribute changes use the upstream rescan queue; runtime CSS
  writes are excluded from that queue. Inline children contribute to their parent's
  own text so a byline is grouped together. Original inline styles are restored on
  stop unless the site has since changed them. Buttons use independent upstream units.
- config/app.js uses the pinned component identity; config/setting.js has no
  remote rule subscriptions. config/index.js excludes the extension settings
  dictionaries. messages.js supplies the few page-runtime UI strings.
- libs/style.js uses Emotion's create-instance entry lazily. Electron runs preload
  before document.head exists; eager upstream keyframes would insert into a null
  container before the IPC listener is registered. Styles now initialize when
  translation starts, after the HTML document is ready.

## Dependencies and scope

- DOMPurify: MIT OR MPL-2.0; retained sanitization.
- Emotion CSS: MIT; retained upstream styles.
- franc-min: MIT; local Chinese-language detection; unknown languages remain
  automatic at the selected Zeus translation service. Short/mixed text can be
  uncertain; this is not a guaranteed classifier.

No OCR, subtitle, local model runtime, extension settings UI, closed Shadow DOM,
cross-origin iframe or PDF support is claimed. KISS and Immersive Translate use
different implementations; identical output on arbitrary websites is not claimed.

## Updating

Compare this directory against the pinned upstream files, then reapply the
documented host changes. Keep upstream copyright and license notices. A newer
upstream release is not accepted solely because it builds: actual translation,
restoration, annotation and dynamic-page behavior require separate acceptance.

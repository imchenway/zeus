import { franc } from 'franc-min';
import { Translator, translationSourceElement } from './upstream/libs/translator.js';
import { BUILTIN_RULES, GLOBLA_RULE, OPT_SPLIT_PARAGRAPH_TEXTLENGTH } from './upstream/config/rules.js';
import { DEFAULT_MOUSE_HOVER_SETTING } from './upstream/config/setting.js';
import { isMatch } from './upstream/libs/utils.js';
import { logger, LogLevel } from './upstream/libs/log.js';

export { translationSourceElement };

/** Source-only annotation extraction excludes page-runtime UI. */
const excludedText = '.kiss-translator-wrapper, .kiss-translator-hover-bubble, #zeus-browser-annotation-root, script, style, noscript, template';
/** Inputs, source code and navigation are not reading paragraphs; button labels remain eligible. */
const ignoredContent =
  'header:not(article header), nav, footer, pre, code, math, script, style, noscript, template, textarea, input, select, option, img, svg, canvas, [hidden], [inert], [aria-hidden="true"], [contenteditable]:not([contenteditable="false"]), [translate="no"], .notranslate, #zeus-browser-annotation-root';

/** Prefer the upstream local site rules; remote subscription code is not loaded. */
export function createPageTranslator(host) {
  logger.setLevel(LogLevel.SILENT);
  /** Unknown languages remain auto-detected by the chosen translation service. */
  const detectLanguage = async (text) => {
    const language = franc(text.slice(0, 2000));
    return language === 'cmn' ? 'zh-CN' : '';
  };
  /** Match only static upstream rule data and discard inheritance markers. */
  const site = BUILTIN_RULES.find((rule) => rule.pattern.split(',').some((pattern) => isMatch(location.href, pattern.trim()))) ?? {};
  /** The Zeus transport intentionally accepts plain text, not provider-specific HTML placeholders. */
  const rule = {
    ...GLOBLA_RULE,
    ...Object.fromEntries(Object.entries(site).filter(([, value]) => value !== '*')),
    apiSlug: 'zeus',
    fromLang: 'auto',
    toLang: 'zh-CN',
    transOpen: 'true',
    blockSelector: [site.blockSelector, 'button, [role="button"]'].filter(Boolean).join(', '),
    hasRichText: 'false',
    keepSelector: ':not(*)',
    hasShadowroot: 'false',
    scanAll: 'false',
    ignoreSelector: [ignoredContent, site.ignoreSelector].filter(Boolean).join(', '),
    splitParagraph: OPT_SPLIT_PARAGRAPH_TEXTLENGTH,
    splitLength: 200,
    transTag: 'span',
    transTitle: 'false',
    wrapOriginal: 'false',
    injectJs: '',
    injectCss: '',
    transStartHook: '',
    transEndHook: '',
  };
  /** KISS retains viewport scheduling, grouping, insertion, mutation handling and restoration. */
  const translator = new Translator({
    rule,
    setting: {
      uiLang: 'zh',
      transApis: [{ apiSlug: 'zeus', apiType: 'zeus', isDisabled: false, placeholder: '{{ }}', placetag: 'i' }],
      mouseHoverSetting: { ...DEFAULT_MOUSE_HOVER_SETTING, useMouseHover: false },
      skipLangs: ['zh-CN', 'zh-TW'],
      translateVariants: false,
      rootMargin: 300,
      transInterval: 0,
      customStyles: [],
      blacklist: '',
      preInit: false,
      parseLatex: false,
    },
    host: { ...host, detectLanguage },
  });
  return { stop: () => translator.stop() };
}

/** Translation ownership comes from KISS's WeakMap, not a website's class names. */
export function isTranslationNode(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element && translationSourceElement(element) !== element);
}

/** Preserve original links and text while removing inserted translation UI from annotation context. */
export function sourceText(element) {
  if (!element) return '';
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) return node.matches(excludedText) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent);
  return parts.join('');
}

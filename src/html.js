import * as cheerio from 'cheerio';
import { parseSrcset, stringifySrcset } from 'srcset';
import { transformCss, transformStyleAttribute } from './css.js';
import { isLikelyAsset } from './url.js';

const ASSET_ATTRIBUTES = [
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['audio[src]', 'src'],
  ['track[src]', 'src'],
  ['script[src]', 'src'],
  ['embed[src]', 'src'],
  ['object[data]', 'data'],
  ['input[type="image"][src]', 'src'],
  ['[data-src]', 'data-src'],
  ['[data-lazy-src]', 'data-lazy-src'],
  ['[data-bg]', 'data-bg'],
  ['[data-background-image]', 'data-background-image'],
];

const SRCSET_ATTRIBUTES = [
  ['img[srcset]', 'srcset'],
  ['source[srcset]', 'srcset'],
  ['[data-srcset]', 'data-srcset'],
];

const REMOVABLE_LINK_RELS = new Set([
  'edituri',
  'pingback',
  'shortlink',
  'wlwmanifest',
  'https://api.w.org/',
]);

function relationTokens(element) {
  return (element.attr('rel') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function isFeedLink(element) {
  const type = (element.attr('type') ?? '').toLowerCase();
  return type.includes('rss') || type.includes('atom') || type.includes('oembed');
}

function rewriteAttribute($, selector, attribute, reference, relation = 'asset') {
  $(selector).each((_, node) => {
    const element = $(node);
    const value = element.attr(attribute);
    if (!value) return;
    element.attr(attribute, reference(value, relation));
  });
}

function rewriteSrcset($, selector, attribute, reference, warn) {
  $(selector).each((_, node) => {
    const element = $(node);
    const value = element.attr(attribute);
    if (!value) return;
    try {
      const entries = parseSrcset(value);
      for (const entry of entries) {
        entry.url = reference(entry.url, 'asset');
      }
      element.attr(attribute, stringifySrcset(entries));
    } catch (error) {
      warn(`Could not parse srcset: ${error.message}`);
    }
  });
}

function rewriteImportMap($, reference, warn) {
  $('script[type="importmap"]').each((_, node) => {
    const element = $(node);
    const raw = element.text();
    try {
      const map = JSON.parse(raw);
      for (const collectionName of ['imports', 'scopes']) {
        const collection = map[collectionName];
        if (!collection || typeof collection !== 'object') continue;
        if (collectionName === 'imports') {
          for (const [name, value] of Object.entries(collection)) {
            if (typeof value === 'string') collection[name] = reference(value, 'asset');
          }
        } else {
          for (const imports of Object.values(collection)) {
            if (!imports || typeof imports !== 'object') continue;
            for (const [name, value] of Object.entries(imports)) {
              if (typeof value === 'string') imports[name] = reference(value, 'asset');
            }
          }
        }
      }
      element.text(JSON.stringify(map));
    } catch (error) {
      warn(`Could not parse an import map: ${error.message}`);
    }
  });
}

export function transformHtml(html, options) {
  const {
    pageUrl,
    reference,
    absolutize,
    publicPageUrl,
    phase = 'rewrite',
    warn = () => {},
  } = options;
  const $ = cheerio.load(html, { decodeEntities: false });

  let documentBase = pageUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    try {
      documentBase = new URL(baseHref, pageUrl).href;
    } catch {
      warn(`Ignored an invalid base URL: ${baseHref}`);
    }
  }
  $('base').remove();

  if (phase === 'rewrite') {
    $('meta[charset]').attr('charset', 'utf-8');
    $('meta[http-equiv="Content-Type" i]').attr('content', 'text/html; charset=utf-8');
  }

  const scopedReference = (raw, relation) => reference(raw, relation, documentBase);

  for (const [selector, attribute] of ASSET_ATTRIBUTES) {
    rewriteAttribute($, selector, attribute, scopedReference, 'asset');
  }
  for (const [selector, attribute] of SRCSET_ATTRIBUTES) {
    rewriteSrcset($, selector, attribute, scopedReference, warn);
  }

  $('iframe[src]').each((_, node) => {
    const element = $(node);
    element.attr('src', scopedReference(element.attr('src'), 'iframe'));
  });

  $('a[href], area[href]').each((_, node) => {
    const element = $(node);
    const value = element.attr('href');
    if (!value) return;
    let asset = element.is('[download]');
    try {
      asset ||= isLikelyAsset(new URL(value, documentBase));
    } catch {
      // The reference handler keeps unsupported URL schemes unchanged.
    }
    element.attr('href', scopedReference(value, asset ? 'asset' : 'page'));
  });

  $('link[href]').each((_, node) => {
    const element = $(node);
    const rels = relationTokens(element);
    if (rels.some((rel) => REMOVABLE_LINK_RELS.has(rel)) || isFeedLink(element)) {
      element.remove();
      return;
    }

    if (rels.includes('canonical')) {
      if (phase === 'rewrite' && publicPageUrl) {
        element.attr('href', publicPageUrl);
      } else if (phase === 'rewrite') {
        element.remove();
      }
      return;
    }

    const asset = rels.some((rel) => [
      'stylesheet', 'icon', 'apple-touch-icon', 'manifest', 'preload', 'modulepreload'
    ].includes(rel));
    const page = rels.some((rel) => ['next', 'prev', 'alternate'].includes(rel));
    if (asset) {
      element.attr('href', scopedReference(element.attr('href'), 'asset'));
      if (phase === 'rewrite' && element.attr('integrity')) element.removeAttr('integrity');
    } else if (page) {
      element.attr('href', scopedReference(element.attr('href'), 'page'));
    }
  });

  $('[style]').each((_, node) => {
    const element = $(node);
    element.attr('style', transformStyleAttribute(element.attr('style'), {
      reference: scopedReference,
      warn,
    }));
  });

  $('style').each((_, node) => {
    const element = $(node);
    element.text(transformCss(element.text(), { reference: scopedReference, warn }));
  });

  $('meta[http-equiv]').each((_, node) => {
    const element = $(node);
    if ((element.attr('http-equiv') ?? '').toLowerCase() !== 'refresh') return;
    const content = element.attr('content') ?? '';
    element.attr('content', content.replace(/(\burl\s*=\s*)([^;]+)/i, (_, prefix, url) => (
      `${prefix}${scopedReference(url.trim().replace(/^['"]|['"]$/g, ''), 'page')}`
    )));
  });

  $('form[action]').each((_, node) => {
    const element = $(node);
    element.attr('action', absolutize(element.attr('action'), documentBase));
  });

  if (phase === 'rewrite') {
    $('meta[property="og:url"]').each((_, node) => {
      const element = $(node);
      if (publicPageUrl) element.attr('content', publicPageUrl);
      else element.remove();
    });
    $('script[integrity]').removeAttr('integrity');
  }

  rewriteImportMap($, scopedReference, warn);
  return $.html();
}

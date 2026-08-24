import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';

import { transformCss, transformStyleAttribute } from '../src/css.js';
import { transformHtml } from '../src/html.js';
import { transformJavaScript } from '../src/javascript.js';
import { transformManifest } from '../src/manifest.js';

function mappingReference(calls) {
  return (raw, relation, base) => {
    calls.push({ raw, relation, base });
    if (/^(?:data:|blob:|#)/.test(raw)) return raw;
    let resolved;
    try {
      resolved = new URL(raw, base ?? 'https://example.test/theme/main.css');
    } catch {
      return raw;
    }
    if (!['http:', 'https:'].includes(resolved.protocol)) return raw;
    return `local:${relation}:${resolved.pathname}${resolved.search}${resolved.hash}`;
  };
}

test('transformCss rewrites imports, images, fonts, image-set values, and leaves inline URLs alone', () => {
  const calls = [];
  const css = `
    @import "./components.css" screen;
    @import url('./print.css') print;
    @font-face { src: url('../fonts/site.woff2') format('woff2'); }
    .hero { background: url(../images/hero.png), url(data:image/png;base64,abc); }
    .variants { background-image: image-set("small.png" 1x, url('large.png') 2x); }
  `;

  const transformed = transformCss(css, { reference: mappingReference(calls) });

  assert.match(transformed, /@import "local:stylesheet:\/theme\/components\.css" screen/);
  assert.match(transformed, /@import url\("local:stylesheet:\/theme\/print\.css"\) print/);
  assert.match(transformed, /url\("local:asset:\/fonts\/site\.woff2"\)/);
  assert.match(transformed, /url\("local:asset:\/images\/hero\.png"\)/);
  assert.match(transformed, /url\(data:image\/png;base64,abc\)/);
  assert.match(transformed, /image-set\("local:asset:\/theme\/small\.png" 1x, url\("local:asset:\/theme\/large\.png"\) 2x\)/);
  assert.ok(calls.some(({ raw, relation }) => raw === './components.css' && relation === 'stylesheet'));
  assert.ok(calls.some(({ raw, relation }) => raw === '../fonts/site.woff2' && relation === 'asset'));
});

test('transformCss and transformStyleAttribute keep malformed source and surface a warning', () => {
  const cssWarnings = [];
  const brokenCss = '.broken { color: red';
  assert.equal(transformCss(brokenCss, {
    reference: () => assert.fail('malformed CSS must not call reference'),
    warn: (message) => cssWarnings.push(message),
  }), brokenCss);
  assert.match(cssWarnings[0], /^Could not parse CSS:/);

  const styleWarnings = [];
  const brokenStyle = 'background: url("missing.png"';
  assert.equal(transformStyleAttribute(brokenStyle, {
    reference: () => assert.fail('malformed style must not call reference'),
    warn: (message) => styleWarnings.push(message),
  }), brokenStyle);
  assert.match(styleWarnings[0], /^Could not parse an inline style:/);
});

test('transformHtml honors base href and rewrites WordPress page and asset references', () => {
  const calls = [];
  const warnings = [];
  const pageUrl = 'https://example.test/posts/hello/';
  const publicPageUrl = 'https://static.test/blog/posts/hello/index.html';
  const html = `<!doctype html>
    <html><head>
      <base href="/content/">
      <meta charset="iso-8859-1">
      <meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
      <meta http-equiv="refresh" content="5; URL='../next/'">
      <meta property="og:url" content="https://old.test/hello/">
      <link rel="canonical" href="https://example.test/posts/hello/">
      <link rel="stylesheet" href="theme.css" integrity="sha256-old">
      <link rel="alternate" type="application/rss+xml" href="/feed/">
      <link rel="https://api.w.org/" href="/wp-json/">
      <link rel="next" href="../page/2/">
      <style>.card { background: url('images/card.png') }</style>
      <script type="importmap">{
        "imports":{"app":"./app.js","bare":"react"},
        "scopes":{"./scope/":{"part":"./part.js"}}
      }</script>
      <script src="scripts/app.js" integrity="sha384-old"></script>
    </head><body style="background-image:url('images/body.png')">
      <a id="page" href="../about/#team">About</a>
      <a id="file" href="files/report.PDF" download>Report</a>
      <area href="../map/">
      <img id="hero" src="images/hero.jpg"
        srcset="images/hero-small.jpg 480w, images/hero-large.jpg 960w"
        data-lazy-src="images/lazy.jpg">
      <source src="media/movie.mp4" srcset="images/still.webp 1x">
      <iframe src="../embed/"></iframe>
      <form action="../wp-comments-post.php"></form>
    </body></html>`;

  const transformed = transformHtml(html, {
    pageUrl,
    publicPageUrl,
    phase: 'rewrite',
    reference: mappingReference(calls),
    absolutize: (raw, base) => new URL(raw, base).href,
    warn: (message) => warnings.push(message),
  });
  const $ = cheerio.load(transformed);

  assert.equal($('base').length, 0);
  assert.equal($('meta[charset]').attr('charset'), 'utf-8');
  assert.equal($('meta[http-equiv="Content-Type"]').attr('content'), 'text/html; charset=utf-8');
  assert.equal($('meta[http-equiv="refresh"]').attr('content'), '5; URL=local:page:/next/');
  assert.equal($('meta[property="og:url"]').attr('content'), publicPageUrl);
  assert.equal($('link[rel="canonical"]').attr('href'), publicPageUrl);
  assert.equal($('link[rel="alternate"]').length, 0);
  assert.equal($('link[rel="https://api.w.org/"]').length, 0);
  assert.equal($('link[rel="stylesheet"]').attr('href'), 'local:asset:/content/theme.css');
  assert.equal($('link[rel="stylesheet"]').attr('integrity'), undefined);
  assert.equal($('link[rel="next"]').attr('href'), 'local:page:/page/2/');
  assert.equal($('#page').attr('href'), 'local:page:/about/#team');
  assert.equal($('#file').attr('href'), 'local:asset:/content/files/report.PDF');
  assert.equal($('area').attr('href'), 'local:page:/map/');
  assert.equal($('#hero').attr('src'), 'local:asset:/content/images/hero.jpg');
  assert.equal(
    $('#hero').attr('srcset'),
    'local:asset:/content/images/hero-small.jpg 480w, local:asset:/content/images/hero-large.jpg 960w',
  );
  assert.equal($('#hero').attr('data-lazy-src'), 'local:asset:/content/images/lazy.jpg');
  assert.equal($('iframe').attr('src'), 'local:iframe:/embed/');
  assert.equal($('form').attr('action'), 'https://example.test/wp-comments-post.php');
  assert.equal($('script[src]').attr('src'), 'local:asset:/content/scripts/app.js');
  assert.equal($('script[src]').attr('integrity'), undefined);
  assert.match($('body').attr('style'), /url\("local:asset:\/content\/images\/body\.png"\)/);
  assert.match($('style').text(), /url\("local:asset:\/content\/images\/card\.png"\)/);

  const importMap = JSON.parse($('script[type="importmap"]').text());
  assert.equal(importMap.imports.app, 'local:asset:/content/app.js');
  assert.equal(importMap.imports.bare, 'local:asset:/content/react');
  assert.equal(importMap.scopes['./scope/'].part, 'local:asset:/content/part.js');
  assert.equal(warnings.length, 0);
  assert.ok(calls.every(({ base }) => base === 'https://example.test/content/'));
});

test('transformHtml removes canonical deployment metadata when no public URL is supplied', () => {
  const transformed = transformHtml(`
    <link rel="canonical" href="https://example.test/">
    <meta property="og:url" content="https://example.test/">
  `, {
    pageUrl: 'https://example.test/',
    phase: 'rewrite',
    reference: (raw) => raw,
    absolutize: (raw) => raw,
  });
  const $ = cheerio.load(transformed);

  assert.equal($('link[rel="canonical"]').length, 0);
  assert.equal($('meta[property="og:url"]').length, 0);
});

test('transformManifest rewrites launch pages, shortcuts, screenshots, and icons', () => {
  const calls = [];
  const source = JSON.stringify({
    name: 'Fixture',
    start_url: '/',
    icons: [{ src: '/icon.png', sizes: '192x192' }],
    screenshots: [{ src: '/screen.png' }],
    shortcuts: [{
      name: 'News',
      url: '/news/',
      icons: [{ src: '/news.png' }],
    }],
  });

  const transformed = transformManifest(source, {
    reference: (raw, relation) => {
      calls.push({ raw, relation });
      return `local:${relation}:${raw}`;
    },
  });
  const manifest = JSON.parse(transformed);

  assert.equal(manifest.start_url, 'local:page:/');
  assert.equal(manifest.icons[0].src, 'local:asset:/icon.png');
  assert.equal(manifest.screenshots[0].src, 'local:asset:/screen.png');
  assert.equal(manifest.shortcuts[0].url, 'local:page:/news/');
  assert.equal(manifest.shortcuts[0].icons[0].src, 'local:asset:/news.png');
  assert.ok(transformed.endsWith('\n'));
  assert.equal(calls.length, 5);
});

test('transformManifest keeps malformed JSON and reports the parse failure', () => {
  const warnings = [];
  const source = '{not json';

  assert.equal(transformManifest(source, {
    reference: () => assert.fail('invalid manifests must not be traversed'),
    warn: (message) => warnings.push(message),
  }), source);
  assert.match(warnings[0], /^Could not parse a web manifest:/);
});

test('transformJavaScript rewrites static and string dynamic module imports', async () => {
  const calls = [];
  const source = `
    import main from './main.js?ver=1';
    export { helper } from '../shared/helper.js';
    import odd from "./foo'bar.js";
    const lazy = import('/chunks/lazy.js');
    const packageImport = import('react');
    const calculated = import('./chunks/' + name + '.js');
  `;

  const transformed = await transformJavaScript(source, {
    reference: (raw, relation) => {
      calls.push({ raw, relation });
      return `local/${raw.replace(/^\.?\//, '')}`;
    },
  });

  assert.match(transformed, /from ["']local\/main\.js\?ver=1["']/);
  assert.match(transformed, /from ["']local\/\.\.\/shared\/helper\.js["']/);
  assert.match(transformed, /from "local\/foo'bar\.js"/);
  assert.match(transformed, /import\("local\/chunks\/lazy\.js"\)/);
  assert.match(transformed, /import\('react'\)/);
  assert.match(transformed, /import\('\.\/chunks\/' \+ name/);
  assert.deepEqual(calls, [
    { raw: './main.js?ver=1', relation: 'asset' },
    { raw: '../shared/helper.js', relation: 'asset' },
    { raw: "./foo'bar.js", relation: 'asset' },
    { raw: '/chunks/lazy.js', relation: 'asset' },
  ]);
});

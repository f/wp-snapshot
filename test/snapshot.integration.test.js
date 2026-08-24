import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';

import { snapshot } from '../src/index.js';

async function startServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function recordHit(hits, request) {
  const target = request.url;
  hits.set(target, (hits.get(target) ?? 0) + 1);
}

function send(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, { 'content-type': contentType, ...extraHeaders });
  response.end(body);
}

function html(response, body, status = 200) {
  send(response, status, 'text/html; charset=utf-8', `<!doctype html><html>${body}</html>`);
}

function resourceFor(result, url) {
  const resource = result.resources.find((candidate) => candidate.url === url);
  assert.ok(resource, `Expected a captured resource for ${url}`);
  return resource;
}

test('snapshot crawls a WordPress-like site and makes the captured tree offline-safe', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'wp-snapshot-integration-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const outputDir = path.join(fixtureRoot, 'output');
  const sourceHits = new Map();
  const externalHits = new Map();

  const externalOrigin = await startServer(t, (request, response) => {
    recordHit(externalHits, request);
    if (request.url === '/cdn/image.png') {
      send(response, 200, 'image/png', Buffer.from('external-image'));
      return;
    }
    html(response, '<body>External page must not be crawled.</body>');
  });

  const sourceOrigin = await startServer(t, (request, response) => {
    recordHit(sourceHits, request);
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const { pathname, searchParams } = requestUrl;

    if (pathname === '/robots.txt') {
      send(response, 200, 'text/plain', [
        'User-agent: *',
        'Disallow: /private/',
        `Sitemap: ${requestUrl.origin}/sitemap-index.xml`,
        '',
      ].join('\n'));
      return;
    }
    if (pathname === '/wp-json/') {
      send(response, 200, 'application/json', JSON.stringify({
        namespaces: ['wp/v2'],
        routes: { '/': {}, '/wp/v2': {} },
      }));
      return;
    }
    if (pathname === '/sitemap-index.xml') {
      send(response, 200, 'application/xml', `
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${requestUrl.origin}/posts-sitemap.xml</loc></sitemap>
        </sitemapindex>`);
      return;
    }
    if (pathname === '/posts-sitemap.xml') {
      send(response, 200, 'application/xml', `
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${requestUrl.origin}/sitemap-only/</loc></url>
          <url><loc>${requestUrl.origin}/?p=42&amp;utm_source=sitemap</loc></url>
        </urlset>`);
      return;
    }
    if (['/wp-sitemap.xml', '/sitemap.xml', '/sitemap_index.xml'].includes(pathname)
      || (pathname === '/' && searchParams.has('sitemap'))) {
      send(response, 404, 'application/xml', '<error/>');
      return;
    }
    if (pathname === '/' && searchParams.get('p') === '42') {
      html(response, '<head><title>Query post</title></head><body><a href="/#home">Home</a></body>');
      return;
    }
    if (pathname === '/') {
      html(response, `<head>
        <base href="/content/">
        <meta charset="iso-8859-1">
        <meta property="og:url" content="${requestUrl.origin}/">
        <link rel="canonical" href="${requestUrl.origin}/">
        <link rel="alternate" type="application/rss+xml" href="/feed/">
        <link rel="stylesheet" href="../wp-content/theme/main.css?ver=1" integrity="sha256-old">
        <link rel="manifest" href="../site.webmanifest">
        <script src="../wp-content/js/app.js" integrity="sha384-old"></script>
        <style>.inline { background-image: url('images/inline.png'); }</style>
      </head><body style="background-image:url('images/body.png')">
        <a id="about" href="../about/#team">About</a>
        <a id="legacy" href="../legacy/#history">Old address</a>
        <a id="query" href="/?p=42&amp;utm_source=homepage#answer">Query post</a>
        <a id="external-page" href="${externalOrigin}/elsewhere/">External page</a>
        <a id="search" href="/?s=term">Search</a>
        <a id="login" href="/wp-login.php">Log in</a>
        <a id="private" href="/private/">Private</a>
        <img id="hero" src="images/hero.jpg"
          srcset="images/hero-1x.jpg 1x, images/hero-2x.jpg 2x"
          data-lazy-src="images/lazy.jpg">
        <img id="external-image" src="${externalOrigin}/cdn/image.png">
        <iframe id="external-frame" src="${externalOrigin}/embed/"></iframe>
        <form action="../wp-comments-post.php"></form>
      </body>`);
      return;
    }
    if (pathname === '/about/') {
      html(response, '<head><title>About</title></head><body><a href="/">Home</a></body>');
      return;
    }
    if (pathname === '/legacy/') {
      response.writeHead(302, { location: '/about/' });
      response.end();
      return;
    }
    if (pathname === '/sitemap-only/') {
      html(response, '<body><img src="/wp-content/images/from-sitemap.png"></body>');
      return;
    }
    if (pathname === '/__wp_snapshot_missing_page__/') {
      html(response, '<head><title>Not found</title></head><body><img src="/wp-content/images/404.png"></body>', 404);
      return;
    }
    if (pathname === '/wp-content/theme/main.css') {
      send(response, 200, 'text/css; charset=utf-8', `
        @import "./nested.css";
        @font-face { font-family: Fixture; src: url('../fonts/site.woff2') format('woff2'); }
        .hero { background-image: url('../images/bg.png'); }
        .set { background-image: image-set("../images/small.png" 1x, url('../images/large.png') 2x); }
      `);
      return;
    }
    if (pathname === '/wp-content/theme/nested.css') {
      send(response, 200, 'text/css', `.nested { background: url('../images/nested.png?rev=2'); }`);
      return;
    }
    if (pathname === '/site.webmanifest') {
      send(response, 200, 'application/manifest+json', JSON.stringify({
        start_url: '/?p=42',
        icons: [{ src: '/wp-content/images/icon.png' }],
      }));
      return;
    }
    if (pathname === '/wp-content/js/app.js') {
      send(response, 200, 'text/javascript', `
        import helper from './chunk.js?ver=1';
        window.fixtureApi = "/wp-json/fixture/v1";
        window.fixtureHelper = helper;
      `);
      return;
    }
    if (pathname === '/wp-content/js/chunk.js') {
      send(response, 200, 'text/javascript', 'export default "captured chunk";');
      return;
    }
    if (pathname === '/wp-content/fonts/site.woff2') {
      send(response, 200, 'font/woff2', Buffer.from('fixture-font'));
      return;
    }
    if (/\.(?:png|jpg)$/.test(pathname)) {
      send(response, 200, pathname.endsWith('.jpg') ? 'image/jpeg' : 'image/png', Buffer.from(`fixture:${pathname}${requestUrl.search}`));
      return;
    }

    html(response, '<body>Unexpected route</body>', 500);
  });

  const result = await snapshot({
    url: sourceOrigin,
    outputDir,
    concurrency: 4,
    timeout: 5_000,
    publicUrl: 'https://static.example/blog/',
    externalAssets: true,
    allowPrivateNetwork: true,
  });

  assert.equal(result.failures.length, 0, JSON.stringify(result.failures, null, 2));
  assert.equal(result.pages, 5, 'home, about, query, sitemap-only, and the 404 template');
  assert.ok(result.assets >= 15);
  assert.equal(result.redirects, 1);
  assert.equal(sourceHits.get('/legacy/'), 1);
  assert.equal(sourceHits.get('/private/') ?? 0, 0);
  assert.equal(sourceHits.get('/wp-login.php') ?? 0, 0);
  assert.equal(sourceHits.get('/?s=term') ?? 0, 0);
  assert.equal(externalHits.get('/cdn/image.png'), 1);
  assert.equal(externalHits.get('/elsewhere/') ?? 0, 0);
  assert.equal(externalHits.get('/embed/') ?? 0, 0);

  const skippedReasons = new Map(result.skipped.map((entry) => [entry.url, entry.reason]));
  assert.equal(skippedReasons.get(`${sourceOrigin}/?s=term`), 'dynamic-page');
  assert.equal(skippedReasons.get(`${sourceOrigin}/wp-login.php`), 'dynamic-page');
  assert.equal(skippedReasons.get(`${sourceOrigin}/private/`), 'robots');
  assert.equal(skippedReasons.get(`${externalOrigin}/elsewhere/`), 'external-page');
  assert.equal(skippedReasons.get(`${externalOrigin}/embed/`), 'external-iframe');

  const indexSource = await readFile(path.join(outputDir, 'index.html'), 'utf8');
  const $ = cheerio.load(indexSource);
  const queryResource = resourceFor(result, `${sourceOrigin}/?p=42`);
  const stylesheetResource = resourceFor(result, `${sourceOrigin}/wp-content/theme/main.css?ver=1`);
  const externalImageResource = resourceFor(result, `${externalOrigin}/cdn/image.png`);

  assert.equal($('base').length, 0);
  assert.equal($('meta[charset]').attr('charset'), 'utf-8');
  assert.equal($('meta[property="og:url"]').attr('content'), 'https://static.example/blog/');
  assert.equal($('link[rel="canonical"]').attr('href'), 'https://static.example/blog/');
  assert.equal($('link[type="application/rss+xml"]').length, 0);
  assert.equal($('#about').attr('href'), './about/index.html#team');
  assert.equal($('#legacy').attr('href'), './about/index.html#history');
  assert.equal($('#query').attr('href'), `./${queryResource.output}#answer`);
  assert.equal($('#external-page').attr('href'), `${externalOrigin}/elsewhere/`);
  assert.equal($('#search').attr('href'), `${sourceOrigin}/?s=term`);
  assert.equal($('#login').attr('href'), `${sourceOrigin}/wp-login.php`);
  assert.equal($('#private').attr('href'), `${sourceOrigin}/private/`);
  assert.equal($('#hero').attr('src'), './content/images/hero.jpg');
  assert.equal(
    $('#hero').attr('srcset'),
    './content/images/hero-1x.jpg 1x, ./content/images/hero-2x.jpg 2x',
  );
  assert.equal($('#hero').attr('data-lazy-src'), './content/images/lazy.jpg');
  assert.equal($('#external-image').attr('src'), `./${externalImageResource.output}`);
  assert.equal($('#external-frame').attr('src'), `${externalOrigin}/embed/`);
  assert.equal($('form').attr('action'), `${sourceOrigin}/wp-comments-post.php`);
  assert.equal($('link[rel="stylesheet"]').attr('href'), `./${stylesheetResource.output}`);
  assert.equal($('link[rel="stylesheet"]').attr('integrity'), undefined);
  assert.equal($('script[src]').attr('integrity'), undefined);
  assert.match($('body').attr('style'), /\.\/content\/images\/body\.png/);
  assert.match($('style').text(), /\.\/content\/images\/inline\.png/);

  const scriptResource = resourceFor(result, `${sourceOrigin}/wp-content/js/app.js`);
  const chunkResource = resourceFor(result, `${sourceOrigin}/wp-content/js/chunk.js?ver=1`);
  const script = await readFile(path.join(outputDir, scriptResource.output), 'utf8');
  assert.match(script, new RegExp(`from ['"]\\./${path.posix.basename(chunkResource.output).replace('.', '\\.')}['"]`));
  assert.equal(await readFile(path.join(outputDir, chunkResource.output), 'utf8'), 'export default "captured chunk";');

  const stylesheet = await readFile(path.join(outputDir, stylesheetResource.output), 'utf8');
  const nestedCssResource = resourceFor(result, `${sourceOrigin}/wp-content/theme/nested.css`);
  const nestedImageResource = resourceFor(result, `${sourceOrigin}/wp-content/images/nested.png?rev=2`);
  assert.match(stylesheet, new RegExp(`@import ["']\\./${path.posix.basename(nestedCssResource.output)}["']`));
  assert.match(stylesheet, /url\("\.\.\/fonts\/site\.woff2"\)/);
  assert.match(stylesheet, /url\("\.\.\/images\/bg\.png"\)/);
  assert.match(stylesheet, /image-set\("\.\.\/images\/small\.png" 1x, url\("\.\.\/images\/large\.png"\) 2x\)/);

  const nestedStylesheet = await readFile(path.join(outputDir, nestedCssResource.output), 'utf8');
  assert.match(nestedStylesheet, new RegExp(`url\\(["']?\\.\\./images/${path.posix.basename(nestedImageResource.output).replace('.', '\\.')}`));

  const manifestResource = resourceFor(result, `${sourceOrigin}/site.webmanifest`);
  const manifest = JSON.parse(await readFile(path.join(outputDir, manifestResource.output), 'utf8'));
  assert.equal(manifest.start_url, `./${queryResource.output}`);
  assert.equal(manifest.icons[0].src, './wp-content/images/icon.png');

  assert.equal(await readFile(path.join(outputDir, '404.html'), 'utf8').then((value) => value.includes('./wp-content/images/404.png')), true);
  assert.equal(await readFile(path.join(outputDir, 'sitemap-only/index.html'), 'utf8').then((value) => value.includes('../wp-content/images/from-sitemap.png')), true);
  assert.equal(await readFile(path.join(outputDir, externalImageResource.output), 'utf8'), 'external-image');
  assert.ok(result.liveDependencies.includes(`${sourceOrigin}/wp-comments-post.php`));
  assert.ok(result.liveDependencies.includes(`${sourceOrigin}/wp-json/fixture/v1`));

  const report = JSON.parse(await readFile(path.join(outputDir, 'wp-snapshot.json'), 'utf8'));
  assert.equal(report.stats.pages, result.pages);
  assert.equal(report.stats.assets, result.assets);
  assert.equal(report.stats.failures, 0);
  assert.ok(report.resources.some(({ output }) => output === '404.html'));
  assert.equal(await readFile(path.join(outputDir, '.nojekyll'), 'utf8'), '');
});

test('snapshot can leave all external assets remote without requesting them', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'wp-snapshot-external-skip-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const externalHits = [];

  const externalOrigin = await startServer(t, (request, response) => {
    externalHits.push(request.url);
    send(response, 200, 'image/png', Buffer.from('must-not-be-fetched'));
  });
  const sourceOrigin = await startServer(t, (request, response) => {
    html(response, `<body>
      <img id="remote" src="${externalOrigin}/remote.png">
      <a id="remote-page" href="${externalOrigin}/page/">Remote page</a>
    </body>`);
  });

  const outputDir = path.join(fixtureRoot, 'output');
  const result = await snapshot({
    url: sourceOrigin,
    outputDir,
    robots: false,
    sitemap: false,
    capture404: false,
    externalAssets: false,
    skipWordPressCheck: true,
  });
  const $ = cheerio.load(await readFile(path.join(outputDir, 'index.html'), 'utf8'));

  assert.deepEqual(externalHits, []);
  assert.equal($('#remote').attr('src'), `${externalOrigin}/remote.png`);
  assert.equal($('#remote-page').attr('href'), `${externalOrigin}/page/`);
  assert.ok(result.skipped.some(({ url, reason }) => (
    url === `${externalOrigin}/remote.png` && reason === 'external-asset'
  )));
  assert.ok(result.skipped.some(({ url, reason }) => (
    url === `${externalOrigin}/page/` && reason === 'external-page'
  )));
});

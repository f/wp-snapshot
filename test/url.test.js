import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assetOutputPath,
  ensureUniqueOutput,
  isDynamicPage,
  isLikelyAsset,
  normalizeKey,
  normalizeUrl,
  pageOutputPath,
  relativeFileReference,
  relativePageReference,
  shortHash,
} from '../src/url.js';

test('normalizeUrl accepts web URLs, removes fragments and tracking parameters, and sorts queries', () => {
  const normalized = normalizeUrl(
    '../post/?utm_source=newsletter&b=two&a=one&FBCLID=ignored#comments',
    'https://example.test/blog/category/',
  );

  assert.equal(normalized?.href, 'https://example.test/blog/post/?a=one&b=two');
  assert.equal(normalizeKey('https://example.test/?z=2&a=1#top'), 'https://example.test/?a=1&z=2');
  assert.equal(normalizeUrl('mailto:hello@example.test'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('not a URL'), null);
});

test('isDynamicPage recognizes WordPress server endpoints and interactive query variants', () => {
  for (const input of [
    'https://example.test/wp-admin/',
    'https://example.test/wp-login.php',
    'https://example.test/wp-json/wp/v2/posts',
    'https://example.test/an-article/feed/',
    'https://example.test/?preview=true',
    'https://example.test/shop/?add-to-cart=12',
    'https://example.test/?S=wordpress',
  ]) {
    assert.equal(isDynamicPage(new URL(input)), true, input);
  }

  assert.equal(isDynamicPage(new URL('https://example.test/?p=42')), false);
  assert.equal(isDynamicPage(new URL('https://example.test/archive/page/2/')), false);
});

test('isLikelyAsset is case-insensitive and leaves extensionless permalinks as pages', () => {
  assert.equal(isLikelyAsset(new URL('https://example.test/uploads/photo.WEBP?size=large')), true);
  assert.equal(isLikelyAsset(new URL('https://example.test/download/report/')), false);
  assert.equal(isLikelyAsset(new URL('https://example.test/about/')), false);
});

test('pageOutputPath maps pretty, file-like, root, and query permalinks to stable files', () => {
  assert.equal(pageOutputPath(new URL('https://example.test/'), { seed: true }), 'index.html');
  assert.equal(pageOutputPath(new URL('https://example.test/')), 'index.html');
  assert.equal(pageOutputPath(new URL('https://example.test/about/')), 'about/index.html');
  assert.equal(pageOutputPath(new URL('https://example.test/archives/old.html')), 'archives/old.html');

  const query = new URL('https://example.test/?p=42');
  assert.equal(
    pageOutputPath(query),
    `_wp_query/p-42~${shortHash(query.search, 10)}/index.html`,
  );

  const nestedQuery = new URL('https://example.test/category/news/?page=2&view=grid');
  assert.equal(
    pageOutputPath(nestedQuery),
    `category/news/_wp_query/page-2_view-grid~${shortHash(nestedQuery.search, 10)}/index.html`,
  );
});

test('output paths sanitize unsafe names, separate external hosts, and retain useful extensions', () => {
  const primaryOrigins = new Set(['https://example.test']);
  const queriedAsset = new URL('https://example.test/wp-content/app.css?ver=1.2.3');
  assert.equal(
    assetOutputPath(queriedAsset, primaryOrigins),
    `wp-content/app~${shortHash(queriedAsset.search, 10)}.css`,
  );

  assert.equal(
    assetOutputPath(new URL('https://cdn.example.test/fonts/site.woff2'), primaryOrigins),
    '_wp_snapshot/external/cdn.example.test/fonts/site.woff2',
  );
  assert.equal(
    assetOutputPath(new URL('https://example.test/CON/logo.svg'), primaryOrigins),
    '_CON/logo.svg',
  );
  assert.equal(
    assetOutputPath(new URL('https://example.test/folder/'), primaryOrigins),
    'folder/asset',
  );
});

test('ensureUniqueOutput handles case-insensitive filesystem collisions deterministically', () => {
  const claims = new Map();
  const first = new URL('https://example.test/About/');
  const second = new URL('https://example.test/about/');

  assert.equal(ensureUniqueOutput('About/index.html', first, claims), 'About/index.html');
  assert.equal(ensureUniqueOutput('About/index.html', first, claims), 'About/index.html');
  assert.equal(
    ensureUniqueOutput('about/index.html', second, claims),
    `about~${shortHash(second.href, 10)}/index.html`,
  );

  const nested = new URL('https://example.test/about/team/');
  assert.equal(
    ensureUniqueOutput('about/team/index.html', nested, claims),
    `about~${shortHash(nested.href, 10)}/team/index.html`,
  );
});

test('relativeFileReference produces offline-safe links and preserves fragments', () => {
  assert.equal(relativeFileReference('index.html', 'about/index.html'), './about/index.html');
  assert.equal(relativeFileReference('posts/one/index.html', 'index.html'), '../../index.html');
  assert.equal(relativeFileReference('posts/one/index.html', 'posts/two/index.html', '#reply'), '../two/index.html#reply');
  assert.equal(relativeFileReference('about/index.html', 'about/index.html', '#team'), '#team');
});

test('relativePageReference keeps directory-index links on trailing-slash URLs', () => {
  assert.equal(relativePageReference('index.html', 'blog/index.html'), './blog/');
  assert.equal(relativePageReference('blog/index.html', 'blog/post/index.html'), './post/');
  assert.equal(relativePageReference('posts/one/index.html', 'index.html'), '../../');
  assert.equal(relativePageReference('posts/one/index.html', 'posts/two/index.html', '#reply'), '../two/#reply');
  assert.equal(relativePageReference('about/index.html', 'about/index.html'), './');
  assert.equal(relativePageReference('about/index.html', 'about/index.html', '#team'), '#team');
  assert.equal(relativePageReference('index.html', 'privacy.html'), './privacy.html');

  const blogUrl = new URL(
    relativePageReference('index.html', 'blog/index.html'),
    'http://localhost:3000/',
  );
  assert.equal(blogUrl.href, 'http://localhost:3000/blog/');
  assert.equal(
    new URL(relativePageReference('blog/index.html', 'blog/post/index.html'), blogUrl).href,
    'http://localhost:3000/blog/post/',
  );
});

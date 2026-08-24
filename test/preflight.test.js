import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { snapshot, SnapshotError } from '../src/index.js';

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('../bin/wp-snapshot.js', import.meta.url));

async function startServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function outputFixture(t, prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, outputDir: path.join(root, 'output') };
}

function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, { 'content-type': contentType, ...headers });
  response.end(body);
}

function wordpressRestRoot() {
  return JSON.stringify({
    name: 'Fixture WordPress',
    namespaces: ['oembed/1.0', 'wp/v2'],
    routes: {
      '/': { namespace: '' },
      '/wp/v2': { namespace: 'wp/v2' },
      '/wp/v2/posts': { namespace: 'wp/v2' },
    },
  });
}

function minimalOptions(url, outputDir, overrides = {}) {
  return {
    url,
    outputDir,
    robots: false,
    sitemap: false,
    capture404: false,
    ...overrides,
  };
}

async function readReport(outputDir) {
  return JSON.parse(await readFile(path.join(outputDir, 'wp-snapshot.json'), 'utf8'));
}

test('preflight accepts a valid standard WordPress REST API root', async (t) => {
  const { outputDir } = await outputFixture(t, 'wp-snapshot-preflight-standard-');
  const hits = [];
  const source = await startServer(t, (request, response) => {
    hits.push(request.url);
    if (request.url === '/') {
      send(response, 200, 'text/html', '<!doctype html><html><body>WordPress site</body></html>');
      return;
    }
    if (request.url === '/wp-json/') {
      send(response, 200, 'application/json', wordpressRestRoot());
      return;
    }
    send(response, 404, 'application/json', '{}');
  });

  const result = await snapshot(minimalOptions(source, outputDir));
  const report = await readReport(outputDir);

  assert.equal(result.pages, 1);
  assert.deepEqual(hits, ['/', '/wp-json/']);
  assert.equal(report.wordpress.verification, 'rest-api');
  assert.equal(report.wordpress.restApi, `${source}/wp-json/`);
});

test('an advertised REST root with a matching WordPress 401 or 403 error counts as protected WordPress', async (t) => {
  for (const status of [401, 403]) {
    const { outputDir } = await outputFixture(t, `wp-snapshot-preflight-protected-${status}-`);
    const hits = [];
    const source = await startServer(t, (request, response) => {
      hits.push(request.url);
      if (request.url === '/') {
        send(response, 200, 'text/html', `<!doctype html><html><head>
          <link rel="https://api.w.org/" href="/protected-rest/">
        </head><body>Protected WordPress</body></html>`);
        return;
      }
      if (request.url === '/protected-rest/') {
        send(response, status, 'application/json', JSON.stringify({
          code: 'rest_authentication_required',
          message: 'Authentication is required to access the REST API.',
          data: { status },
        }));
        return;
      }
      send(response, 404, 'application/json', '{}');
    });

    const result = await snapshot(minimalOptions(source, outputDir));
    const report = await readReport(outputDir);

    assert.equal(result.pages, 1);
    assert.deepEqual(hits, ['/', '/protected-rest/']);
    assert.equal(report.wordpress.verification, 'protected-rest-api');
    assert.equal(report.wordpress.restApi, `${source}/protected-rest/`);
  }
});

test('preflight rejects a non-WordPress site before robots, sitemaps, pages, or assets are crawled', async (t) => {
  const { root, outputDir } = await outputFixture(t, 'wp-snapshot-preflight-reject-');
  const hits = [];
  const source = await startServer(t, (request, response) => {
    hits.push(request.url);
    if (request.url === '/') {
      send(response, 200, 'text/html', `<!doctype html><html><body>
        <a href="/must-not-crawl/">Another page</a>
        <img src="/must-not-download.png">
      </body></html>`);
      return;
    }
    if (request.url === '/wp-json/') {
      send(response, 200, 'application/json', JSON.stringify({ message: 'an unrelated JSON API' }));
      return;
    }
    if (new URL(request.url, 'http://fixture.test').searchParams.get('rest_route') === '/') {
      send(response, 200, 'application/json', JSON.stringify({ namespaces: [], routes: {} }));
      return;
    }
    send(response, 200, 'text/plain', 'this endpoint must not be reached');
  });

  await assert.rejects(
    snapshot(minimalOptions(source, outputDir, { robots: true, sitemap: true })),
    (error) => error instanceof SnapshotError && error.code === 'E_NOT_WORDPRESS',
  );

  assert.deepEqual(hits, ['/', '/wp-json/', '/?rest_route=/']);
  assert.equal(hits.includes('/robots.txt'), false);
  assert.equal(hits.includes('/must-not-crawl/'), false);
  assert.equal(hits.includes('/must-not-download.png'), false);
  await assert.rejects(access(outputDir));
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.wp-snapshot-')), []);
});

for (const discovery of ['html-link', 'http-link-header']) {
  test(`preflight uses a ${discovery === 'html-link' ? 'REST discovery link' : 'REST discovery HTTP Link header'} with a custom prefix`, async (t) => {
    const { outputDir } = await outputFixture(t, `wp-snapshot-preflight-${discovery}-`);
    const hits = [];
    const restPath = discovery === 'html-link' ? '/custom-api/' : '/headless-api/';
    const source = await startServer(t, (request, response) => {
      hits.push(request.url);
      if (request.url === '/') {
        const discoveryMarkup = discovery === 'html-link'
          ? `<link rel="https://api.w.org/" href="${restPath}">`
          : '';
        const headers = discovery === 'http-link-header'
          ? { link: `<${restPath}>; rel="https://api.w.org/"` }
          : {};
        send(
          response,
          200,
          'text/html',
          `<!doctype html><html><head>${discoveryMarkup}</head><body>WordPress</body></html>`,
          headers,
        );
        return;
      }
      if (request.url === restPath) {
        send(response, 200, 'application/json', wordpressRestRoot());
        return;
      }
      send(response, 404, 'application/json', '{}');
    });

    const result = await snapshot(minimalOptions(source, outputDir));

    assert.equal(result.pages, 1);
    assert.deepEqual(hits, ['/', restPath]);
    assert.equal(hits.includes('/wp-json/'), false);
    assert.equal(hits.includes('/?rest_route=/'), false);
  });
}

test('preflight falls back to the plain-permalink REST route when /wp-json/ is disabled', async (t) => {
  const { outputDir } = await outputFixture(t, 'wp-snapshot-preflight-plain-rest-');
  const hits = [];
  const source = await startServer(t, (request, response) => {
    hits.push(request.url);
    if (request.url === '/') {
      send(response, 200, 'text/html', '<!doctype html><html><body>WordPress</body></html>');
      return;
    }
    if (request.url === '/wp-json/') {
      send(response, 403, 'application/json', JSON.stringify({ code: 'rest_forbidden' }));
      return;
    }
    if (new URL(request.url, 'http://fixture.test').searchParams.get('rest_route') === '/') {
      send(response, 200, 'application/json', wordpressRestRoot());
      return;
    }
    send(response, 404, 'text/plain', 'missing');
  });

  const result = await snapshot(minimalOptions(source, outputDir));

  assert.equal(result.pages, 1);
  assert.deepEqual(hits, ['/', '/wp-json/', '/?rest_route=/']);
});

test('skipWordPressCheck snapshots an intentionally REST-disabled WordPress site', async (t) => {
  const { root, outputDir } = await outputFixture(t, 'wp-snapshot-preflight-disabled-');
  const hits = [];
  const source = await startServer(t, (request, response) => {
    hits.push(request.url);
    if (request.url === '/') {
      send(response, 200, 'text/html', '<!doctype html><html><body>REST is intentionally disabled.</body></html>');
      return;
    }
    if (request.url === '/wp-json/' || request.url === '/?rest_route=/') {
      send(response, 403, 'application/json', JSON.stringify({ code: 'rest_disabled' }));
      return;
    }
    send(response, 404, 'text/plain', 'missing');
  });

  await assert.rejects(
    snapshot(minimalOptions(source, outputDir)),
    (error) => error instanceof SnapshotError && error.code === 'E_NOT_WORDPRESS',
  );
  await assert.rejects(access(outputDir));

  hits.length = 0;
  const overriddenOutput = path.join(root, 'overridden-output');
  const result = await snapshot(minimalOptions(source, overriddenOutput, {
    skipWordPressCheck: true,
  }));
  const report = await readReport(overriddenOutput);

  assert.equal(result.pages, 1);
  assert.deepEqual(hits, ['/']);
  assert.equal(report.wordpress.verification, 'skipped');
  assert.equal(report.wordpress.restApi, null);
});

test('CLI --skip-wordpress-check exposes the REST-disabled override', async (t) => {
  const { outputDir } = await outputFixture(t, 'wp-snapshot-preflight-cli-');
  const hits = [];
  const source = await startServer(t, (request, response) => {
    hits.push(request.url);
    if (request.url === '/') {
      send(response, 200, 'text/html', '<!doctype html><html><body>WordPress with REST disabled.</body></html>');
      return;
    }
    send(response, 403, 'application/json', JSON.stringify({ code: 'rest_disabled' }));
  });

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI_PATH,
    source,
    '--output', outputDir,
    '--skip-wordpress-check',
    '--ignore-robots',
    '--no-sitemap',
    '--no-404',
    '--quiet',
  ]);

  assert.equal(stdout, '');
  assert.equal(stderr, '');
  assert.deepEqual(hits, ['/']);
  await access(path.join(outputDir, 'index.html'));
});

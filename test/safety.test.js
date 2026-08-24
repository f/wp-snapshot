import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { snapshot, SnapshotError } from '../src/index.js';

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

function send(response, status, type, body, headers = {}) {
  response.writeHead(status, { 'content-type': type, ...headers });
  response.end(body);
}

function html(response, body) {
  send(response, 200, 'text/html; charset=utf-8', `<!doctype html><html>${body}</html>`);
}

async function fixtureOutput(t, prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, output: path.join(root, 'output') };
}

test('an aborted snapshot removes staging and never commits partial output', async (t) => {
  const { root, output } = await fixtureOutput(t, 'wp-snapshot-abort-');
  const source = await startServer(t, (request, response) => {
    if (request.url === '/') {
      html(response, '<body><img src="/slow-a"><img src="/slow-b"></body>');
      return;
    }
    setTimeout(() => send(response, 200, 'image/png', Buffer.alloc(1024)), 250);
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(snapshot({
    url: source,
    outputDir: output,
    robots: false,
    sitemap: false,
    capture404: false,
    skipWordPressCheck: true,
    signal: controller.signal,
  }), (error) => error instanceof SnapshotError && error.code === 'E_ABORT');

  await assert.rejects(access(output));
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.wp-snapshot-')), []);
});

test('concurrent redirect aliases share one captured record and output', async (t) => {
  const { output } = await fixtureOutput(t, 'wp-snapshot-alias-');
  const source = await startServer(t, (request, response) => {
    if (request.url === '/') {
      html(response, '<body><a href="/one">One</a><a href="/two">Two</a></body>');
      return;
    }
    if (request.url === '/one' || request.url === '/two') {
      response.writeHead(302, { location: '/final/' });
      response.end();
      return;
    }
    html(response, '<body>Final</body>');
  });

  const result = await snapshot({
    url: source,
    outputDir: output,
    robots: false,
    sitemap: false,
    capture404: false,
    skipWordPressCheck: true,
    concurrency: 4,
  });

  assert.equal(result.failures.length, 0);
  assert.equal(result.pages, 2);
  assert.equal(result.resources.filter(({ url }) => url === `${source}/final/`).length, 1);
  assert.equal(new Set(result.resources.map(({ output: file }) => file)).size, result.resources.length);
});

test('external sitemaps and assets are not fetched by default', async (t) => {
  const { root, output } = await fixtureOutput(t, 'wp-snapshot-external-default-');
  const externalHits = [];
  const external = await startServer(t, (request, response) => {
    externalHits.push(request.url);
    send(response, 200, 'image/png', 'remote');
  });
  const mappedExternal = `http://[::ffff:7f00:1]:${new URL(external).port}`;
  const source = await startServer(t, (request, response) => {
    if (request.url === '/robots.txt') {
      send(response, 200, 'text/plain', `User-agent: *\nSitemap: ${external}/sitemap.xml\n`);
      return;
    }
    if (request.url === '/') {
      html(response, `<body>
        <img src="${external}/remote.png">
        <img src="${mappedExternal}/hex-mapped.png">
      </body>`);
      return;
    }
    send(response, 404, 'text/plain', 'missing');
  });

  const result = await snapshot({
    url: source,
    outputDir: output,
    capture404: false,
    skipWordPressCheck: true,
  });
  assert.deepEqual(externalHits, []);
  assert.ok(result.skipped.some(({ reason }) => reason === 'external-sitemap'));
  assert.ok(result.skipped.some(({ reason }) => reason === 'external-asset'));

  const privateResult = await snapshot({
    url: source,
    outputDir: path.join(root, 'private-output'),
    capture404: false,
    externalAssets: true,
    skipWordPressCheck: true,
  });
  assert.deepEqual(externalHits, []);
  assert.ok(privateResult.failures.some(({ reason }) => reason === 'E_PRIVATE_NETWORK'));
});

test('sensitive headers stay stripped after an external redirect returns to the source', async (t) => {
  const { output } = await fixtureOutput(t, 'wp-snapshot-header-taint-');
  let privateAuthorization = null;
  let source;
  const external = await startServer(t, (_request, response) => {
    response.writeHead(302, { location: `${source}/private-secret` });
    response.end();
  });
  source = await startServer(t, (request, response) => {
    if (request.url === '/') {
      html(response, `<body><img src="${external}/bounce"></body>`);
      return;
    }
    if (request.url === '/private-secret') {
      privateAuthorization = request.headers.authorization ?? null;
      send(
        response,
        200,
        'text/plain',
        privateAuthorization ? 'PRIVATE DATA' : 'public fallback',
      );
      return;
    }
    send(response, 404, 'text/plain', 'missing');
  });

  const result = await snapshot({
    url: source,
    outputDir: output,
    robots: false,
    sitemap: false,
    capture404: false,
    externalAssets: true,
    allowPrivateNetwork: true,
    skipWordPressCheck: true,
    headers: { Authorization: 'Bearer SECRET' },
  });

  assert.equal(privateAuthorization, null);
  const redirected = result.resources.find(({ url }) => url === `${source}/private-secret`);
  assert.ok(redirected);
  assert.equal(await readFile(path.join(output, redirected.output), 'utf8'), 'public fallback');
});

test('the deployable report redacts signed URLs and WordPress nonces', async (t) => {
  const { output } = await fixtureOutput(t, 'wp-snapshot-redaction-');
  const source = await startServer(t, (request, response) => {
    if (request.url === '/') {
      html(response, `<body>
        <img src="/signed.png?signature=TOPSECRET&amp;ver=1">
        <a href="/?preview=true&amp;preview_nonce=WPSECRET">Preview</a>
      </body>`);
      return;
    }
    send(response, 200, 'image/png', 'signed image');
  });

  await snapshot({
    url: source,
    outputDir: output,
    robots: false,
    sitemap: false,
    capture404: false,
    skipWordPressCheck: true,
  });
  const report = await readFile(path.join(output, 'wp-snapshot.json'), 'utf8');
  assert.doesNotMatch(report, /TOPSECRET|WPSECRET/);
  assert.match(report, /%5Bredacted%5D/);
  assert.match(report, /ver=1/);
});

test('file and directory output collisions are separated safely', async (t) => {
  const { output } = await fixtureOutput(t, 'wp-snapshot-prefix-collision-');
  const source = await startServer(t, (request, response) => {
    if (request.url === '/') {
      html(response, '<body><img src="/foo"><a href="/foo/bar/">Nested page</a></body>');
      return;
    }
    if (request.url === '/foo') {
      send(response, 200, 'application/octet-stream', 'asset');
      return;
    }
    setTimeout(() => html(response, '<body>Nested</body>'), 20);
  });

  const result = await snapshot({
    url: source,
    outputDir: output,
    robots: false,
    sitemap: false,
    capture404: false,
    skipWordPressCheck: true,
  });
  assert.equal(result.failures.length, 0);
  const asset = result.resources.find(({ url }) => url === `${source}/foo`);
  const page = result.resources.find(({ url }) => url === `${source}/foo/bar/`);
  assert.equal(asset.output, 'foo');
  assert.match(page.output, /^foo~[a-f0-9]+\/bar\/index\.html$/);
  assert.equal(await readFile(path.join(output, asset.output), 'utf8'), 'asset');
  assert.match(await readFile(path.join(output, page.output), 'utf8'), /Nested/);
});

test('parent directory casing is stable for case-sensitive deployments', async (t) => {
  const { output } = await fixtureOutput(t, 'wp-snapshot-case-collision-');
  const source = await startServer(t, (request, response) => {
    if (request.url === '/') {
      html(response, '<body><a href="/About/">About</a><a href="/about/team/">Team</a></body>');
      return;
    }
    html(response, `<body>${request.url}</body>`);
  });

  const result = await snapshot({
    url: source,
    outputDir: output,
    robots: false,
    sitemap: false,
    capture404: false,
    skipWordPressCheck: true,
  });
  const about = result.resources.find(({ url }) => url === `${source}/About/`);
  const team = result.resources.find(({ url }) => url === `${source}/about/team/`);
  assert.equal(about.output, 'About/index.html');
  assert.match(team.output, /^about~[a-f0-9]+\/team\/index\.html$/);
  assert.match(await readFile(path.join(output, about.output), 'utf8'), /\/About\//);
  assert.match(await readFile(path.join(output, team.output), 'utf8'), /\/about\/team\//);
});

test('chunked resources stop at maxResourceBytes', async (t) => {
  const { output } = await fixtureOutput(t, 'wp-snapshot-size-limit-');
  const source = await startServer(t, (request, response) => {
    if (request.url === '/') {
      html(response, '<body><img src="/large.bin"></body>');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write(Buffer.alloc(900));
    response.write(Buffer.alloc(900));
    response.end(Buffer.alloc(900));
  });

  const result = await snapshot({
    url: source,
    outputDir: output,
    robots: false,
    sitemap: false,
    capture404: false,
    maxResourceBytes: 1024,
    skipWordPressCheck: true,
  });
  assert.ok(result.failures.some(({ url, reason }) => (
    url === `${source}/large.bin` && reason === 'E_SIZE'
  )));
  assert.equal(result.resources.some(({ url }) => url === `${source}/large.bin`), false);
});

test('clean only replaces marked outputs unless forceClean is explicit', async (t) => {
  const { output } = await fixtureOutput(t, 'wp-snapshot-clean-');
  await mkdir(output);
  await writeFile(path.join(output, 'notes.txt'), 'user data', 'utf8');
  const source = await startServer(t, (_request, response) => html(response, '<body>Site</body>'));

  await assert.rejects(snapshot({
    url: source,
    outputDir: output,
    clean: true,
    robots: false,
    sitemap: false,
    capture404: false,
    skipWordPressCheck: true,
  }), (error) => error instanceof SnapshotError && error.code === 'E_OUTPUT_UNMARKED');

  await snapshot({
    url: source,
    outputDir: output,
    forceClean: true,
    robots: false,
    sitemap: false,
    capture404: false,
    skipWordPressCheck: true,
  });
  await assert.rejects(access(path.join(output, 'notes.txt')));
  assert.match(await readFile(path.join(output, '.wp-snapshot-output'), 'utf8'), /^wp-snapshot@/);
});

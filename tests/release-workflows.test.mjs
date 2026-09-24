/**
 * Release gate for the workflow files.
 *
 * The two workflow files are the last gate before a tarball reaches the registry, so
 * what they *prove* matters as much as what they run. Three properties are asserted:
 *
 *  - every job that runs Node pins the release Node version explicitly, instead of
 *    inheriting whatever the runner image happens to ship;
 *  - the DSH runtime the integration suites resolve is the version those suites are
 *    written against, and every environment variable they read is exported, so a
 *    missing or misplaced install fails the job instead of silently skipping the
 *    deployment evidence cases;
 *  - the protection that already exists — tag/package/built-version agreement, the
 *    tag-only publish trigger and the credential gate — is still there, so a rewrite
 *    cannot quietly publish behind a weakened check.
 *
 * Expected values are derived from the repository (the tests that read the runtime,
 * the shipped `files` list) rather than hard-coded, so a new runtime variable or a new
 * shipped entrypoint cannot outgrow the gate unnoticed.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = relative => path.join(root, relative);
const manifest = JSON.parse(readFileSync(at('package.json'), 'utf8'));

/** The DSH version this release is adapted to; see R21 and `tests/host-config.test.mjs`. */
const TARGET_DSH_VERSION = '0.1.7-rc.1';

/**
 * Floors for npm trusted publishing, from npm's own documentation
 * (`packages-and-modules/securing-your-code/trusted-publishers.mdx`): npm >= 11.5.1
 * and Node >= 22.14, with `id-token: write` on a GitHub-hosted runner. Provenance is
 * generated automatically for a public package from a public repository, so no extra
 * publish flag is part of the contract.
 */
const NPM_TRUSTED_PUBLISHING_FLOOR = [11, 5, 1];
const NODE_TRUSTED_PUBLISHING_FLOOR = [22, 14];

/** Compare dotted versions against a floor, treating a missing part as zero. */
function atLeast(version, floor) {
  const parts = String(version).split('.').map(part => Number.parseInt(part, 10));
  for (const [index, minimum] of floor.entries()) {
    const value = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (value !== minimum) return value > minimum;
  }
  return true;
}

function workflowFiles() {
  const directory = at('.github/workflows');
  return readdirSync(directory).filter(name => /\.ya?ml$/u.test(name)).sort()
    .map(name => ({ name, text: readFileSync(path.join(directory, name), 'utf8') }));
}

/** Job blocks keyed by job id, split on the two-space indentation under `jobs:`. */
function jobsOf(text) {
  const lines = text.split('\n');
  const jobs = new Map();
  const start = lines.findIndex(line => /^jobs:\s*$/u.test(line));
  assert.notEqual(start, -1, 'a workflow must declare a jobs block');
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current !== null) jobs.get(current).push(line);
  }
  assert.ok(jobs.size > 0, 'a workflow must declare at least one job');
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

/** Environment variables the suites read to find a real DSH runtime. */
function runtimeVariables() {
  const directory = at('tests');
  const names = new Set();
  for (const file of readdirSync(directory).filter(name => name.endsWith('.test.mjs'))) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    for (const match of source.matchAll(/process\.env\.(FILE_MANAGER_DSH_[A-Z0-9_]*RUNTIME_ROOT)/gu)) names.add(match[1]);
  }
  assert.ok(names.size > 0, 'at least one suite must declare how it finds the DSH runtime');
  return [...names].sort();
}

const RUNS_NODE = /npm ci|npm run|npm test|npm pack|node --input-type|node -e/u;
const INSTALLS_RUNTIME = /npm install --global "@deepseek-ai\/dsh@/u;

test('every workflow job that runs Node pins the release Node version', () => {
  for (const { name, text } of workflowFiles()) {
    for (const [job, body] of jobsOf(text)) {
      if (!RUNS_NODE.test(body)) continue;
      assert.match(body, /uses:\s*actions\/setup-node@v\d+/u, `${name}:${job} runs Node without actions/setup-node`);
      assert.match(body, /node-version:\s*['"]?(\d+)['"]?/u, `${name}:${job} must state the Node version it runs`);
      const pinned = /node-version:\s*['"]?(\d+)['"]?/u.exec(body)[1];
      assert.equal(pinned, '24', `${name}:${job} must run on Node 24, the version this package builds and ships against`);
    }
  }
});

test('every runtime-dependent suite can actually resolve the runtime in CI', () => {
  const variables = runtimeVariables();
  const installers = workflowFiles().filter(({ text }) => INSTALLS_RUNTIME.test(text));
  assert.ok(installers.length > 0, 'at least one workflow must install the DSH runtime the suites resolve');
  for (const { name, text } of installers) {
    assert.match(text, new RegExp(`DSH_RUNTIME_VERSION:\\s*['"]?${TARGET_DSH_VERSION}['"]?`, 'u'),
      `${name} must install DSH ${TARGET_DSH_VERSION}, the version these suites are written against`);
    for (const variable of variables) {
      assert.match(text, new RegExp(`echo "${variable}=|^\\s*${variable}:`, 'mu'),
        `${name} must export ${variable}, otherwise the suites reading it skip their deployment evidence`);
    }
    // A skip is not a neutral outcome here: it is the suite that proves the plugin
    // still fits the deployed runtime. The install must be asserted, not hoped for.
    assert.match(text, /test -f "\$\{!?[A-Za-z_]+\}\/package\.json"/u,
      `${name} must assert the installed runtime resolves before the suites run`);
  }
});

test('no workflow installs a different DSH runtime than the suites target', () => {
  for (const { name, text } of workflowFiles()) {
    // Versions can reach the install through a shell variable; the placeholder is not
    // a version, so compare the declared values instead.
    const declared = [...text.matchAll(/DSH_RUNTIME_VERSION:\s*['"]?([^\s'"$]+)['"]?/gu)].map(match => match[1]);
    for (const version of declared) {
      assert.equal(version, TARGET_DSH_VERSION, `${name} installs DSH ${version}, not ${TARGET_DSH_VERSION}`);
    }
    for (const match of text.matchAll(/@deepseek-ai\/dsh@([^\s"']+)/gu)) {
      if (match[1].startsWith('$')) continue;
      assert.equal(match[1], TARGET_DSH_VERSION, `${name} installs DSH ${match[1]}, not ${TARGET_DSH_VERSION}`);
    }
  }
});

test('the release keeps its tag agreement and trigger', () => {
  const release = workflowFiles().find(({ name }) => name.startsWith('release'));
  assert.ok(release, 'a release workflow must exist');
  const jobs = jobsOf(release.text);
  const verify = jobs.get('verify-version');
  assert.ok(verify, 'the release workflow must keep its verify-version job');
  assert.match(verify, /\.version/u, 'verify-version must read the version from package.json');
  assert.match(verify, /import\('\.\/dist\/index\.js'\)/u, 'verify-version must read the built wire version');
  assert.match(verify, /GITHUB_REF_NAME.*!=.*v\$version/u, 'verify-version must refuse a tag that disagrees with the version');

  assert.match(release.text, /tags:\s*\['v\*'\]/u, 'the release trigger stays tag-driven');
  assert.match(release.text, /workflow_dispatch:/u, 'a manual release verification stays possible');

  const publish = jobs.get('publish');
  assert.ok(publish, 'the release workflow must keep its publish job');
  assert.match(publish, /if:\s*github\.ref_type == 'tag'/u, 'publishing must stay limited to tag runs');
  assert.match(publish, /npm publish --access public/u, 'the publish command and its access flag stay unchanged');
  // The credential gate is deliberately not asserted here any more: the release moved
  // to OIDC trusted publishing, and the properties that replace it live in the next
  // test. Keeping the old assertion would demand a token gate and forbid it at once.
  assert.doesNotMatch(publish, /secrets\.NPM_TOKEN/u, 'the stored-token gate must stay gone');
});

test('no workflow carries credential material and every shipped entrypoint is asserted', () => {
  const declared = new Set(manifest.files.filter(entry => !entry.startsWith('!')));
  const ci = workflowFiles().find(({ name }) => name.startsWith('ci'));
  assert.ok(ci, 'a CI workflow must exist');
  for (const { name, text } of workflowFiles()) {
    assert.doesNotMatch(text, /npm_[A-Za-z0-9]{20,}/u, `${name} must not carry a literal npm token`);
  }
  // The pack assertion lists entrypoints inside a shell `for ... in` continuation, so
  // each entry may carry a trailing backslash.
  const checked = [...ci.text.matchAll(/^\s{12}package\/([^\s\\]+)/gmu)].map(match => match[1]);
  assert.ok(checked.length > 0, 'CI must assert the packed entrypoints by name');
  for (const entry of ['dist/index.js', 'dist/client.js', 'cordis.patch.yml']) {
    assert.ok(checked.includes(entry), `CI must keep asserting that the tarball ships ${entry}`);
  }
  // Anything the package now ships at the top level and the release depends on should
  // be visible in the pack assertion instead of resting on a directory glob.
  assert.ok(declared.has('THIRD-PARTY-NOTICES.md'), 'the notices file must stay part of the published files');
  assert.ok(checked.includes('THIRD-PARTY-NOTICES.md'),
    'CI must assert that the tarball ships THIRD-PARTY-NOTICES.md, which the release now depends on');
});

// The release channel is npm trusted publishing (OIDC), so the workflow must carry
// no stored credential at all: the registry mints a short-lived token from this job's
// identity, and a missing credential must fail the release rather than skip it.
test('publishing uses the workflow identity instead of a stored credential', () => {
  const release = workflowFiles().find(({ name }) => name.startsWith('release'));
  const jobs = jobsOf(release.text);
  const publish = jobs.get('publish');
  assert.ok(publish, 'the release workflow must keep its publish job');

  // With trusted publishing the registry accepts a short-lived token minted from the
  // workflow's own OIDC identity, so the job has to be allowed to request one and
  // must not carry a long-lived credential anywhere.
  assert.match(publish, /permissions:[\s\S]*?id-token:\s*write/u,
    'the publish job must request an OIDC token with id-token: write');
  assert.match(publish, /permissions:[\s\S]*?contents:\s*read/u,
    'the publish job must not ask for more than contents: read');
  assert.doesNotMatch(publish, /secrets\./u,
    'publishing must not read a stored credential from repository secrets');
  assert.doesNotMatch(release.text, /NODE_AUTH_TOKEN/u,
    'no release step may inject a stored npm token into the environment');
  assert.doesNotMatch(publish, /steps\.credentials\.outputs/u,
    'the token-presence gate must be gone; a missing credential is no longer a silent skip');
  assert.match(publish, /registry-url:\s*https:\/\/registry\.npmjs\.org/u,
    'the official registry must stay explicit for the OIDC exchange');
  // Official floor for trusted publishing (npm/docs, trusted-publishers.mdx): the
  // bundled npm on a runner is not guaranteed to be new enough, so the job has to
  // install a known-good npm itself instead of hoping the image ships one.
  assert.match(publish, /npm install --global npm@\d+\.\d+\.\d+/u,
    'the publish job must install a pinned npm before publishing');
  const npmVersion = /npm install --global npm@(\d+\.\d+\.\d+)/u.exec(publish)[1];
  assert.ok(atLeast(npmVersion, NPM_TRUSTED_PUBLISHING_FLOOR),
    `pinned npm ${npmVersion} must satisfy the trusted publishing floor ${NPM_TRUSTED_PUBLISHING_FLOOR.join('.')}`);
  const nodeVersion = /node-version:\s*['"]?(\d+(?:\.\d+)*)['"]?/u.exec(publish)?.[1];
  assert.ok(nodeVersion !== undefined, 'the publish job must pin its Node version');
  assert.ok(atLeast(nodeVersion, NODE_TRUSTED_PUBLISHING_FLOOR),
    `Node ${nodeVersion} must satisfy the trusted publishing floor ${NODE_TRUSTED_PUBLISHING_FLOOR.join('.')}`);
  // A job that goes to the trouble of pinning npm must not restore a dependency cache
  // on the way; the cache is for the verification jobs, not for the publish identity.
  assert.doesNotMatch(publish, /cache:\s*npm/u, 'the publish job must not restore an npm cache');
  // The tag-only trigger and the runtime evidence stay part of the gate.
  assert.match(release.text, /tags:\s*\['v\*'\]/u, 'the release trigger stays tag-driven');
  assert.match(publish, /test -f "\$\{!?[A-Za-z_]+\}\/package\.json"/u,
    'the publish job must keep asserting that the target DSH runtime resolves');
});

/**
 * Host configuration boundary against DSH 0.1.7-rc.1.
 *
 * DSH 0.1.6-alpha.2 exposed `ctx.settings` as a `SettingsProvider`: a plugin
 * called `settings.register(namespace, schema, options)` and read the resolved
 * values back with `settings.get(namespace)`.
 *
 * DSH 0.1.7-rc.1 replaced that service with `SettingsForms`: forms over the
 * Loader entries. `register` and `get` are gone, and a plugin's configuration
 * is declared once as an exported schemastery `Config` schema on the plugin
 * module; the Loader validates the profile row's `config` against it and hands
 * the result to `apply(ctx, config)` as the second argument.
 *
 * These cases pin that boundary: the plugin must mount against a Host whose
 * `settings` service only has the 0.1.7 surface (or no `settings` service at
 * all), and its limits must come from the Loader row.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LIMIT_DEFAULTS, LIMIT_NAMES, SETTINGS_NAMESPACE } from '../dist/contracts/limits.js';

const base = new URL('../', import.meta.url);
const plugin = () => import('../dist/index.js');

// The runtime under evidence. Deliberately NOT the variable runtime-storage.test.mjs
// uses for "the deployed runtime": this suite is about 0.1.7-rc.1 specifically, and
// pointing it at an older installation would make the evidence meaningless.
const runtimeRoot = process.env.FILE_MANAGER_DSH_017_RUNTIME_ROOT ?? '/usr/local/dsh-0.1.7-rc.1/lib/node_modules/@deepseek-ai/dsh';
const runtimeAvailable = existsSync(path.join(runtimeRoot, 'package.json'));
const skipWithoutRuntime = runtimeAvailable ? false : `no DSH runtime at ${runtimeRoot}; set FILE_MANAGER_DSH_017_RUNTIME_ROOT to run the deployment evidence case`;

/**
 * A `ctx.settings` shaped exactly like DSH 0.1.7-rc.1's `SettingsForms`: forms
 * over Loader entries. Every method records its use and refuses, so a plugin
 * that still expects the alpha.2 namespace API cannot pass by accident.
 */
function settingsService() {
  const calls = [];
  const refuse = name => () => {
    calls.push(name);
    throw new Error(`the Host plugin must not call settings.${name}: 0.1.7-rc.1 has no runtime namespace registration`);
  };
  return {
    calls,
    service: {
      writable: true,
      documentPath: '/tmp/profile.yml',
      prepareDocument: refuse('prepareDocument'),
      describe: refuse('describe'),
      configure: refuse('configure'),
      update: refuse('update'),
      replace: refuse('replace'),
      mutate: refuse('mutate'),
    },
  };
}

/** A Host composition with the 0.1.7 service set; `settings` may be absent entirely. */
function host({ settings } = {}) {
  const routes = new Map();
  const disposers = [];
  const stores = new Map();
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
    workspaceRegistry: { list: () => [] },
    ...(settings === undefined ? {} : { settings }),
    storageDomain: {
      async open(spec) {
        if (!stores.has(spec.name)) stores.set(spec.name, structuredClone(spec.global.initial));
        const records = new Map();
        return {
          global: {
            get: () => structuredClone(stores.get(spec.name)),
            async set(value) { stores.set(spec.name, spec.global.schema.parse(value)); },
          },
          table(name) {
            if (!records.has(name)) records.set(name, new Map());
            const table = records.get(name);
            return {
              entries: () => table.entries(),
              async put(key, value) { table.set(key, spec.tables[name].valueSchema.parse(structuredClone(value))); },
            };
          },
          async close() {},
        };
      },
    },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose; },
  };
  return {
    ctx, routes,
    async bootstrap() {
      const route = routes.get('/api/file-manager/v2/control');
      assert.ok(route, 'the control route must be mounted');
      const response = await route.fetch(new Request('http://localhost/api/file-manager/v2/control', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'bootstrap' }),
      }));
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body.value;
    },
    async close() { for (const dispose of disposers.reverse()) await dispose?.(); },
  };
}

test('the Host plugin mounts when the settings service only has the 0.1.7 surface', async () => {
  const module = await plugin();
  const settings = settingsService();
  const fixture = host({ settings: settings.service });
  await module.apply(fixture.ctx, {});
  assert.deepEqual(settings.calls, [], 'the removed namespace-registration API must not be touched');
  assert.equal(fixture.routes.size, 6, 'the frozen v2 route table registers six routes');
  const bootstrap = await fixture.bootstrap();
  assert.equal(bootstrap.degraded, null, `a 0.1.7 Host must not degrade the file manager: ${JSON.stringify(bootstrap.degraded)}`);
  assert.equal(bootstrap.capabilities.write, true, 'the write surface stays available');
  assert.deepEqual(bootstrap.limits, { ...LIMIT_DEFAULTS }, 'an empty Config row resolves to the contract defaults');
  await fixture.close();
});

test('the Host plugin mounts with no settings service at all', async () => {
  const module = await plugin();
  const fixture = host();
  await module.apply(fixture.ctx);
  const bootstrap = await fixture.bootstrap();
  assert.equal(bootstrap.degraded, null);
  assert.equal(bootstrap.capabilities.tasks, true);
  await fixture.close();
});

test('the Loader Config row supplies the effective limits', async () => {
  const module = await plugin();
  const fixture = host({ settings: settingsService().service });
  await module.apply(fixture.ctx, { maxTextBytes: 4096, transferConcurrency: 4 });
  const bootstrap = await fixture.bootstrap();
  assert.equal(bootstrap.limits.maxTextBytes, 4096);
  assert.equal(bootstrap.limits.transferConcurrency, 4);
  assert.equal(bootstrap.limits.maxFileBytes, LIMIT_DEFAULTS.maxFileBytes, 'unset limits keep their contract defaults');
  await fixture.close();
});

test('an out-of-bounds Config row fails activation instead of degrading the surface', async () => {
  const module = await plugin();
  const fixture = host({ settings: settingsService().service });
  await assert.rejects(module.apply(fixture.ctx, { maxTextBytes: 0 }), { code: 'INVALID_STATE' });
  assert.equal(fixture.routes.size, 0, 'an invalid configuration must mount nothing at all');
  await fixture.close();
});

test('the plugin declares every limit as an exported Config schema', async () => {
  const module = await plugin();
  assert.equal(typeof module.Config, 'function', 'a 0.1.7 Host plugin declares its config as an exported schemastery Config');
  assert.equal(typeof module.Config['~standard'], 'object', 'the Loader validates Config through Standard Schema');
  const resolved = module.Config['~standard'].validate(undefined);
  assert.equal(resolved.issues, undefined, JSON.stringify(resolved.issues));
  assert.deepEqual(resolved.value, { ...LIMIT_DEFAULTS }, 'a row without config resolves to the declared defaults');
  for (const name of LIMIT_NAMES) assert.ok(name in resolved.value, `${name} must be a declared config field`);
  const configured = module.Config['~standard'].validate({ maxTextBytes: 4096 });
  assert.equal(configured.issues, undefined);
  assert.equal(configured.value.maxTextBytes, 4096);
  for (const invalid of [{ maxTextBytes: 0 }, { maxTextBytes: 32 * 1024 * 1024 + 1 }, { transferConcurrency: 9 }, { pollIntervalMs: 1 }]) {
    assert.ok(module.Config['~standard'].validate(invalid).issues,
      `the Loader must refuse ${JSON.stringify(invalid)} instead of clamping it`);
  }
});

test('the Host plugin injects only services DSH 0.1.7-rc.1 still provides', async () => {
  const module = await plugin();
  for (const service of ['connection', 'workspaceRegistry', 'storageDomain']) {
    assert.ok(module.inject.includes(service), `the plugin still depends on ${service}`);
  }
  assert.equal(module.inject.includes('settings'), false,
    'settings no longer carries namespace registration, so the plugin must not wait on it');
});

test('the config section identity is the bundle row id', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', base), 'utf8');
  const id = patch.match(/id:\s*([A-Za-z0-9._-]+)/)?.[1];
  assert.equal(id, SETTINGS_NAMESPACE, 'the config form is keyed by the profile entry id');
});

test('the deployed 0.1.7-rc.1 settings service really has no register or get', { skip: skipWithoutRuntime }, async () => {
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  const version = JSON.parse(await readFile(path.join(runtimeRoot, 'package.json'), 'utf8')).version;
  assert.match(version, /^0\.1\.7-rc\.1$/, 'this evidence case is only meaningful against the targeted release');
  const real = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-settings')).href);
  const SettingsForms = real.SettingsForms ?? real.default;
  const service = Object.create(SettingsForms.prototype);
  assert.equal(typeof service.register, 'undefined', 'the alpha.2 namespace registration is gone');
  assert.equal(typeof service.get, 'undefined', 'the alpha.2 namespace read is gone');
  assert.equal(typeof service.describe, 'function', 'the 0.1.7 form surface is what a Host provides');

  const module = await plugin();
  const fixture = host({ settings: service });
  await module.apply(fixture.ctx, {});
  const bootstrap = await fixture.bootstrap();
  assert.equal(bootstrap.degraded, null, 'the plugin must mount against the real 0.1.7 settings service');
  assert.equal(bootstrap.capabilities.write, true);
  await fixture.close();
});

test('the deployed cordis loader resolves the Config row before apply', { skip: skipWithoutRuntime }, async () => {
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  const { resolveConfig } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href);
  const module = await plugin();
  // `resolveConfig` is the exact function the Loader runs over a row's `config`.
  assert.deepEqual(resolveConfig({ Config: module.Config }, undefined), { ...LIMIT_DEFAULTS });
  assert.equal(resolveConfig({ Config: module.Config }, { maxTextBytes: 4096 }).maxTextBytes, 4096);
  assert.throws(() => resolveConfig({ Config: module.Config }, { transferConcurrency: 9 }), /transferConcurrency/,
    'an out-of-bounds row must be refused by the Loader, not clamped by the plugin');
});

test('the deployed cordis boots the plugin with the row config and serves it', { skip: skipWithoutRuntime }, async () => {
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  const { Context } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href);
  const module = await plugin();
  const fixture = host();
  const ctx = new Context();
  ctx.provide('connection', fixture.ctx.connection);
  ctx.provide('workspaceRegistry', fixture.ctx.workspaceRegistry);
  ctx.provide('storageDomain', fixture.ctx.storageDomain);
  ctx.provide('settings', Object.create((await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-settings')).href)).SettingsForms.prototype));
  await ctx.plugin({ name: 'local-file-manager', apply: module.apply, inject: module.inject, Config: module.Config }, { maxTextBytes: 4096 });
  const bootstrap = await fixture.bootstrap();
  assert.equal(bootstrap.degraded, null);
  assert.equal(bootstrap.limits.maxTextBytes, 4096, 'the real Loader must hand the validated row config to apply');
  await ctx.fiber.dispose();
  await fixture.close();
});

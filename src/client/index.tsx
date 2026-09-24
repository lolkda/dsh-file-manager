/**
 * The Client module the Harness mounts.
 *
 * `apply` registers the sidebar entry, the independent main panel and the
 * composer reference bridge. Every registration goes through `ctx.effect` or
 * `ctx.slots.inject`, so unmounting the plugin releases the locale dictionaries,
 * the abort controllers and every slot the plugin owns.
 *
 * The module also exports its building blocks (`documents`, `activity`, `sse`,
 * `i18n`, `api`, `editor`, `codeLanguages`) so the test suite can exercise the
 * shipped artifact directly. They are the plugin's own modules — no internal
 * state, and no recovery proof from the Host, is exposed here.
 */

import * as api from './api.js';
import * as documents from './documents.js';
import * as activity from './activity.js';
import * as sse from './sse.js';
import * as i18n from './i18n.js';
import * as editor from './code-editor.js';
import * as codeLanguages from './code-languages.js';
import { createDocumentStore } from './documents.js';
import { createActivityStore } from './activity.js';
import { en, NS, zh, type Translate } from './i18n.js';
import { FolderIcon } from './browser.js';
import { Panel, type PanelRuntime } from './panel.js';
import { ReferenceBridge, type ReferenceRecord, type ReferenceScope } from './reference.js';
import primitives from '@deepseek-ai/dsh-client-ui-primitives';

export { api, documents, activity, sse, i18n, editor, codeLanguages };
// Named factories the component suites use directly, alongside the namespace
// exports above. They expose no internal state — only the public constructors.
export { createDocumentStore } from './documents.js';
export { createActivityStore } from './activity.js';
export { consumeEvents } from './sse.js';
export { CodeEditor } from './code-editor.js';

export interface ClientContext {
  readonly slots: {
    inject(name: string, callback: () => (() => void) | void): unknown;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  readonly locale: {
    register(namespace: string, locale: string, dictionary: Record<string, string>): () => void;
    bind(namespace: string): Translate;
  };
  readonly sessions?: { scope(sessionId: string): ReferenceScope | null } | undefined;
  readonly uiWorkspace?: { openSession(sessionId: string): void } | undefined;
  effect(callback: () => (() => void) | void): unknown;
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace'];

export function apply(ctx: ClientContext): void {
  const documentStore = createDocumentStore();
  const activityStore = createActivityStore<ReferenceRecord>();
  const runtime: PanelRuntime = {
    controller: new AbortController(),
    location: { rootId: '', path: '' },
    relocations: new Set<string>(),
    uploads: new Map(),
    openSession: ctx.uiWorkspace ? (sessionId: string) => ctx.uiWorkspace?.openSession(sessionId) : null,
    // The reference bridge inserts into a session's composer scope, so the scope
    // factory travels with the shared runtime rather than with the panel.
    referenceScope: ctx.sessions ? (sessionId: string) => ctx.sessions?.scope(sessionId) ?? null : null,
  };
  ctx.effect(() => () => runtime.controller.abort());
  ctx.effect(() => ctx.locale.register(NS, 'en', en));
  ctx.effect(() => ctx.locale.register(NS, 'zh-CN', zh));
  ctx.effect(() => ctx.locale.register(NS, 'zh', zh));
  const t = ctx.locale.bind(NS);
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'file-manager', order: -10, label: () => t('title') },
    FolderIcon,
  ));
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'file-manager', locale: NS, inject: () => ({ documents: documentStore, activity: activityStore, ui: primitives, runtime }) },
    Panel,
  ));
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'file-manager-reference-bridge', locale: NS, inject: () => ({ activity: activityStore, runtime, ui: primitives }) },
    ReferenceBridge,
  ));
}

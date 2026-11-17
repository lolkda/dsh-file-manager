/**
 * The Client module the Harness mounts.
 *
 * `apply` registers the sidebar entry, the independent main panel and the
 * composer reference bridge. Every registration goes through `ctx.effect` or
 * `ctx.slots.inject`, so unmounting the plugin releases the locale dictionaries,
 * the abort controllers and every slot the plugin owns.
 *
 * The module also exports its building blocks (`documents`, `activity`, `sse`,
 * `i18n`, `api`, `editor`, `codeLanguages`, `notifications`, `notificationEvents`)
 * so the test suite can exercise the shipped artifact directly. They are the
 * plugin's own modules — no internal state, and no Host root state, is exposed
 * here.
 */

import * as api from './api.js';
import * as documents from './documents.js';
import * as activity from './activity.js';
import * as sse from './sse.js';
import * as i18n from './i18n.js';
import * as fileSize from './file-size.js';
import * as editor from './code-editor.js';
import * as codeLanguages from './code-languages.js';
import * as notifications from './notifications.js';
import * as notificationEvents from './notification-events.js';
import { createDocumentStore } from './documents.js';
import { createActivityStore } from './activity.js';
import { createNotificationStore } from './notifications.js';
import { createNotificationEvents } from './notification-events.js';
import { en, NS, zh, type Translate } from './i18n.js';
import { FolderIcon } from './browser.js';
import { Panel, type PanelRuntime } from './panel.js';
import { ReferenceBridge, type ReferenceRecord, type ReferenceScope } from './reference.js';
import primitives from '@deepseek-ai/dsh-client-ui-primitives';

export { api, documents, activity, sse, i18n, fileSize, editor, codeLanguages, notifications, notificationEvents };
export * as overlay from './overlay.js';
// Named factories the component suites use directly, alongside the namespace
// exports above. They expose no internal state — only the public constructors.
export { createDocumentStore } from './documents.js';
export { createActivityStore } from './activity.js';
export { createNotificationStore } from './notifications.js';
export { createNotificationEvents, reportTerminalNotification, REFERENCE_PENDING_CODE } from './notification-events.js';
export { PATH_COPY_FAILED_CODE, pathCopyNotification, usePathCopy } from './path-copy.js';
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
  // The notification store belongs to the plugin, not to the panel: switching
  // panels keeps the history, unloading the plugin discards it and releases the
  // activity subscription it observes.
  const notificationStore = createNotificationStore();
  const notificationRuntime = createNotificationEvents({ notifications: notificationStore, activity: activityStore, t });
  ctx.effect(() => () => {
    notificationRuntime.dispose();
    notificationStore.dispose();
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'file-manager', order: -10, label: () => t('title') },
    FolderIcon,
  ));
  ctx.slots.inject('main', () => ctx.slots.register(
    {
      name: 'main', key: 'file-manager', locale: NS,
      inject: () => ({
        documents: documentStore, activity: activityStore, notifications: notificationStore,
        // A direct terminal result the UI already holds is reported through this
        // bound helper, which shares the observer's key so it is shown once.
        reportTerminal: notificationRuntime.reportTerminal,
        ui: primitives, runtime,
      }),
    },
    Panel,
  ));
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'file-manager-reference-bridge', locale: NS, inject: () => ({ activity: activityStore, runtime, ui: primitives }) },
    ReferenceBridge,
  ));
}

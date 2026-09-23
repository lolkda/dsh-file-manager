/**
 * The slice of the DSH Host context this plugin consumes. Declared structurally
 * so the plugin never imports a Host implementation type, and so tests can pass
 * a small fake context.
 */
import type { ProfileLimits } from '../contracts/limits.js';

export interface PluginLogger {
  error?(message: string): void;
  warn?(message: string): void;
  info?(message: string): void;
}

export interface RouteRegistration {
  path: string;
  methods?: readonly string[] | undefined;
  /** `'streaming'` keeps the body unbuffered; `'buffered'` hands over a parsed body. */
  requestBody?: string | undefined;
  fetch(request: Request): Promise<Response>;
}

export interface ConnectionService {
  fetch: { register(route: RouteRegistration): () => unknown };
}

export interface WorkspaceCandidateView {
  id: string;
  path: string;
  title: string;
}

export interface WorkspaceRegistryService {
  list(): WorkspaceCandidateView[];
}

export interface SettingsService {
  /** `schema` is a schemastery schema; the Host calls it to materialize defaults. */
  register(namespace: string, schema: unknown, options?: { applies?: string }): void;
  get(namespace: string): ProfileLimits;
}

export interface StorageTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

export interface StorageDomainHandle {
  global: { get(): unknown; set(value: unknown): Promise<void> };
  table(name: string): StorageTable;
  close(): Promise<void>;
}

export interface StorageOpenSpec {
  name: string;
  version: number;
  layout: string;
  global: { schema: unknown; initial: unknown };
  tables: Record<string, { valueSchema: unknown }>;
}

export interface StorageDomainService {
  open(spec: StorageOpenSpec): Promise<StorageDomainHandle>;
}

export interface PluginContext {
  logger?: PluginLogger | undefined;
  connection: ConnectionService;
  workspaceRegistry: WorkspaceRegistryService;
  settings: SettingsService;
  storageDomain: StorageDomainService;
  /** Registers a Host-owned resource; the callback returns its disposer. */
  effect(callback: () => unknown): unknown;
}

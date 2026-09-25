/**
 * Root-owned document store.
 *
 * The store outlives any mounted main-panel view, so switching panels can never
 * discard an unsaved draft. It is deliberately I/O-free: callers hand it a
 * disk snapshot, and every disk-derived decision (dirty, external, missing) is
 * expressed as state the view renders.
 *
 * Save responses are bound to an attempt identity. A response that belongs to an
 * attempt the store has already replaced — because the document was relocated,
 * a newer save started, or the document was closed — must not touch state, clear
 * a newer in-flight attempt, or recreate a removed document.
 */

import type { EntryVersion } from '../contracts/protocol.js';

export class DocumentStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocumentStoreError';
    this.code = code;
  }
}

/** A disk snapshot of an editable text file, as returned by `text.read`. */
export interface FileSnapshot {
  readonly rootId: string;
  readonly path: string;
  readonly text: string;
  /** The content-bound version token the Host issued for this snapshot. */
  readonly version: EntryVersion;
  readonly bytes?: number;
  readonly bom?: boolean;
  readonly newline?: string;
  readonly encoding?: string;
  readonly mode?: number;
}

/** The save receipt: the same snapshot without the body text. */
export type SnapshotReceipt = Omit<FileSnapshot, 'text'>;

export interface OpenDocument {
  readonly id: string;
  readonly rootId: string;
  readonly path: string;
  readonly base: FileSnapshot;
  readonly draft: string;
  readonly dirty: boolean;
  readonly external: FileSnapshot | null;
  readonly missing: boolean;
  readonly editing: boolean;
  readonly saving: boolean;
  /** Save/read generation; deletion also invalidates every older response. */
  readonly attempt: number;
}

export interface DocumentState {
  readonly documents: readonly OpenDocument[];
  readonly activeId: string | null;
}

/** Identity handed to a caller that started an asynchronous save. */
export interface SaveAttempt {
  readonly documentId: string;
  readonly attempt: number;
}

export interface OpenOptions {
  readonly activate?: boolean;
}

export interface CloseOptions {
  readonly discard?: boolean;
}

export interface DocumentStore {
  getSnapshot(): DocumentState;
  subscribe(listener: () => void): () => void;
  activate(id: string): void;
  open(incoming: unknown, options?: OpenOptions): string;
  edit(id: string, text: string): void;
  /** Legacy flag setter; prefer `beginSave` / `saveSettled` on asynchronous paths. */
  saving(id: string, saving: boolean): void;
  /** Claims the document for a save attempt and invalidates any previous attempt. */
  beginSave(id: string): SaveAttempt;
  isSaveCurrent(attempt: SaveAttempt): boolean;
  /** Releases the saving flag only while the given attempt still owns it. */
  saveSettled(target: string | SaveAttempt): void;
  saved(target: string | SaveAttempt, receipt: SnapshotReceipt, submittedDraft: string, actualSnapshot?: unknown): boolean;
  conflict(id: string, incoming: unknown): void;
  rebase(id: string): void;
  markMissing(rootId: string, prefix?: string): void;
  relocate(id: string, incoming: unknown): void;
  close(id: string, options?: CloseOptions): boolean;
}

const normalize = (text: string): string => text.replace(/\r\n|\r/g, '\n');

/** Anything that names one file: a disk snapshot, a receipt, or an open document. */
interface FileRef {
  readonly rootId: string;
  readonly path: string;
}

const sameRef = (a: FileRef, b: FileRef): boolean => a.rootId === b.rootId && a.path === b.path;

/** Declared as a function so call sites narrow after a failed guard. */
function invalid(code: string, message: string): never {
  throw new DocumentStoreError(code, message);
}

/**
 * Accepts an untrusted disk snapshot. Only the fields the Host actually returns
 * for `text.read` are adopted, so a response body can never smuggle arbitrary
 * properties into the document state a view renders.
 */
function validate(input: unknown): FileSnapshot {
  if (typeof input !== 'object' || input === null) {
    invalid('INVALID_SNAPSHOT', 'A complete file text snapshot is required.');
  }
  const record = input as Record<string, unknown>;
  const { rootId, path: filename, version, text } = record;
  if (typeof rootId !== 'string' || typeof filename !== 'string' || typeof version !== 'string' || typeof text !== 'string') {
    invalid('INVALID_SNAPSHOT', 'A complete file text snapshot is required.');
  }
  const snapshot: {
    rootId: string;
    path: string;
    // The Host mints this token; the store validates that it is a non-empty
    // string and keeps the contract's brand for the callers that send it back.
    version: EntryVersion;
    text: string;
    bytes?: number;
    bom?: boolean;
    newline?: string;
    encoding?: string;
    mode?: number;
  } = { rootId, path: filename, version: version as EntryVersion, text };
  if (typeof record.bytes === 'number') snapshot.bytes = record.bytes;
  if (typeof record.bom === 'boolean') snapshot.bom = record.bom;
  if (typeof record.newline === 'string') snapshot.newline = record.newline;
  if (typeof record.encoding === 'string') snapshot.encoding = record.encoding;
  if (typeof record.mode === 'number') snapshot.mode = record.mode;
  return snapshot;
}

function freezeDocument(document: OpenDocument): OpenDocument {
  return Object.freeze({
    ...document,
    base: Object.freeze({ ...document.base }),
    external: document.external ? Object.freeze({ ...document.external }) : null,
  });
}

const isAttempt = (target: string | SaveAttempt): target is SaveAttempt => typeof target !== 'string';

export function createDocumentStore(): DocumentStore {
  let serial = 0;
  let state: DocumentState = Object.freeze({ documents: Object.freeze([] as readonly OpenDocument[]), activeId: null });
  const listeners = new Set<() => void>();

  function commit(documents: readonly OpenDocument[], activeId: string | null = state.activeId): void {
    state = Object.freeze({ documents: Object.freeze(documents.map(freezeDocument)), activeId });
    for (const listener of listeners) listener();
  }

  function require_(id: string): OpenDocument {
    const document = state.documents.find(item => item.id === id);
    if (!document) invalid('DOCUMENT_NOT_FOUND', 'This document is no longer open.');
    return document;
  }

  function update(id: string, change: (document: OpenDocument) => OpenDocument): void {
    require_(id);
    commit(state.documents.map(document => (document.id === id ? change(document) : document)));
  }

  return {
    getSnapshot: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    activate(id) {
      require_(id);
      commit(state.documents, id);
    },

    open(incoming, { activate = true } = {}) {
      const next = validate(incoming);
      const previous = state.documents.find(document => sameRef(document, next));
      if (previous) {
        // A dirty draft is never replaced by a background refresh; the incoming
        // disk version becomes the comparison target instead.
        const changed: OpenDocument = previous.dirty
          ? { ...previous, external: next.version === previous.base.version ? null : next, missing: false }
          : { ...previous, base: next, draft: normalize(next.text), external: null, missing: false };
        commit(state.documents.map(document => (document.id === previous.id ? changed : document)), activate ? previous.id : state.activeId);
        return previous.id;
      }
      const id = `document-${++serial}`;
      commit([
        ...state.documents,
        {
          id, rootId: next.rootId, path: next.path, base: next, draft: normalize(next.text),
          dirty: false, external: null, missing: false, editing: false, saving: false, attempt: 0,
        },
      ], activate ? id : state.activeId);
      return id;
    },

    edit(id, text) {
      if (typeof text !== 'string') invalid('INVALID_TEXT', 'The editor draft must be text.');
      update(id, document => ({ ...document, draft: text, dirty: text !== normalize(document.base.text), editing: true }));
    },

    saving(id, saving) {
      update(id, document => ({ ...document, saving }));
    },

    beginSave(id) {
      const document = require_(id);
      const attempt = document.attempt + 1;
      commit(state.documents.map(item => (item.id === id ? { ...item, saving: true, attempt } : item)));
      return Object.freeze({ documentId: id, attempt });
    },

    isSaveCurrent(attempt) {
      const document = state.documents.find(item => item.id === attempt.documentId);
      return Boolean(document && document.saving && document.attempt === attempt.attempt);
    },

    saveSettled(target) {
      const document = state.documents.find(item => item.id === (isAttempt(target) ? target.documentId : target));
      if (!document) return;
      if (isAttempt(target) && (!document.saving || document.attempt !== target.attempt)) return;
      commit(state.documents.map(item => (item.id === document.id ? { ...item, saving: false } : item)));
    },

    saved(target, receipt, submittedDraft, actualSnapshot) {
      const document = state.documents.find(item => item.id === (isAttempt(target) ? target.documentId : target));
      if (!document) {
        // A response for a document that no longer exists is dropped: it must
        // never recreate the document or resurrect a discarded draft.
        if (isAttempt(target)) return false;
        invalid('DOCUMENT_NOT_FOUND', 'This document is no longer open.');
      }
      if (isAttempt(target) && (!document.saving || document.attempt !== target.attempt)) return false;
      update(document.id, current => {
        if (!sameRef(current, receipt)) invalid('REFERENCE_MISMATCH', 'The save receipt belongs to a different file.');
        let base: FileSnapshot;
        if (actualSnapshot !== undefined) {
          base = validate(actualSnapshot);
          if (!sameRef(current, base)) invalid('REFERENCE_MISMATCH', 'The verified snapshot belongs to a different file.');
          if (base.version !== receipt.version) invalid('VERSION_CONFLICT', 'The file changed after the save receipt was issued.');
        } else {
          // Uniform-EOL callers are retained; the UI always supplies the
          // verified disk snapshot and never guesses mixed or CR endings.
          if (receipt.newline === 'mixed' || receipt.newline === 'cr') invalid('INVALID_SNAPSHOT', 'Nonuniform or CR line endings require the actual saved snapshot.');
          let text = normalize(submittedDraft);
          if (receipt.newline === 'crlf') text = text.replace(/\n/g, '\r\n');
          base = { ...current.base, ...receipt, text };
        }
        return { ...current, base, dirty: current.draft !== normalize(base.text), external: null, missing: false, saving: false };
      });
      return true;
    },

    conflict(id, incoming) {
      const latest = validate(incoming);
      update(id, document => {
        if (!sameRef(document, latest)) invalid('REFERENCE_MISMATCH', 'The conflict snapshot belongs to a different file.');
        return { ...document, external: latest };
      });
    },

    rebase(id) {
      update(id, document => {
        if (!document.external) invalid('INVALID_STATE', 'There is no disk version to use as a new base.');
        return { ...document, base: document.external, dirty: document.draft !== normalize(document.external.text), external: null, missing: false };
      });
    },

    markMissing(rootId, prefix) {
      commit(state.documents.map(document => (
        document.rootId === rootId && (!prefix || document.path === prefix || document.path.startsWith(`${prefix}/`))
          ? { ...document, missing: true, saving: false, attempt: document.attempt + 1 }
          : document
      )));
    },

    relocate(id, incoming) {
      const next = validate(incoming);
      if (state.documents.some(document => document.id !== id && sameRef(document, next))) {
        invalid('DOCUMENT_CONFLICT', 'The destination path already has an open document.');
      }
      update(id, document => {
        const sameContents = document.base.text === next.text && document.base.bom === next.bom && document.base.newline === next.newline;
        return {
          ...document,
          rootId: next.rootId,
          path: next.path,
          missing: false,
          // The path part of an in-flight save is now wrong; the attempt owner
          // has to start over instead of committing against the old location.
          attempt: document.saving ? document.attempt + 1 : document.attempt,
          base: !document.dirty || sameContents ? next : { ...document.base, rootId: next.rootId, path: next.path },
          draft: document.dirty ? document.draft : normalize(next.text),
          external: document.dirty && !sameContents ? next : null,
        };
      });
    },

    close(id, { discard = false } = {}) {
      const document = state.documents.find(item => item.id === id);
      if (!document) return true;
      if (document.saving || (document.dirty && !discard)) return false;
      const next = state.documents.filter(item => item.id !== id);
      const activeId = state.activeId === id ? next[next.length - 1]?.id ?? null : state.activeId;
      commit(next, activeId);
      return true;
    },
  };
}
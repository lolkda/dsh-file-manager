/**
 * Minimal ambient types for `yazl` (the package ships no declarations).
 * The archive is only ever fed held, verified streams, never an absolute path.
 */
declare module 'yazl' {
  import type { Readable } from 'node:stream';

  export interface EntryOptions {
    mtime?: Date | undefined;
    mode?: number | undefined;
  }

  export interface ReadStreamOptions extends EntryOptions {
    size: number;
    compress?: boolean | undefined;
  }

  export class ZipFile {
    outputStream: Readable & { destroy(error?: Error): void };
    addEmptyDirectory(metadataPath: string, options?: EntryOptions): void;
    /**
     * yazl calls `getReadStream` when the entry is reached and expects it to
     * hand the entry's stream to the supplied callback.
     */
    addReadStreamLazy(
      metadataPath: string,
      options: ReadStreamOptions,
      getReadStream: (callback: (error: Error | null, stream?: Readable) => void) => void,
    ): void;
    end(options?: { forceZip64Format?: boolean | undefined }): void;
    on(event: string, listener: (error: Error) => void): this;
  }

  export function dateToDosDateTime(date: Date): number;
}

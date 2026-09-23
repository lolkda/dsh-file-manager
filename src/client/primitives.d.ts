/**
 * The UI primitives are supplied by the browser module table, not by this
 * package: the bundle keeps `@deepseek-ai/dsh-client-ui-primitives` external so
 * the Host UI can theme and update them independently.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { UiPrimitives } from './ui.js';

  const primitives: UiPrimitives;
  export = primitives;
}

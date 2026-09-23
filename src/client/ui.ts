/**
 * The UI primitive boundary.
 *
 * The primitives come from the browser module table
 * (`@deepseek-ai/dsh-client-ui-primitives`), so the Client declares only the
 * props it actually uses. The props stay open (`Record<string, unknown>`) so a
 * primitive can accept attributes this plugin does not know about, while every
 * attribute the plugin *does* pass is visible at the call site.
 */

import type { ComponentType, ReactNode } from 'react';

export type PrimitiveProps = Record<string, unknown> & { children?: ReactNode };

// Exact subset of the installed Menu declaration used by the paste dialog.
// Unlike native select, the shared Menu owns its themed popup and positioning.
export interface PrimitiveMenuProps {
  open: boolean;
  anchor: ReactNode;
  items: readonly { id: string; label: ReactNode; disabled?: boolean }[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  portal?: boolean;
  autoFocus?: boolean;
  className?: string;
}

export interface UiPrimitives {
  readonly Button: ComponentType<PrimitiveProps>;
  readonly Menu: ComponentType<PrimitiveMenuProps>;
  readonly Input: ComponentType<PrimitiveProps>;
  readonly Modal: ComponentType<PrimitiveProps>;
  readonly Checkbox: ComponentType<PrimitiveProps>;
  readonly RiskConfirmation: ComponentType<PrimitiveProps>;
}

/**
 * One dialog attempt at a time, identified by identity rather than by id string:
 * a cancelled, replaced or superseded attempt can never publish a late response
 * back into the view, and its identity is what makes a retry of the same logical
 * action reuse one request id instead of minting a new one.
 */
export class AttemptSlot<T extends { id: string; phase: string }> {
  private current: T | null = null;

  begin(attempt: T): T {
    this.current = attempt;
    return attempt;
  }

  peek(): T | null {
    return this.current;
  }

  isCurrent(attempt: T): boolean {
    return this.current === attempt;
  }

  /** Applies `change` only while `attempt` is still the active one. */
  update(attempt: T, change: Partial<T>): T | null {
    if (this.current !== attempt) return null;
    Object.assign(attempt, change);
    return attempt;
  }

  /** Clears the slot; without an argument it clears whatever is current. */
  clear(attempt?: T): void {
    if (attempt === undefined || this.current === attempt) this.current = null;
  }
}

import type { ReactNode } from 'react';

export interface StatusMessageProps {
  kind: 'loading' | 'empty' | 'error';
  title: string;
  detail?: string;
  action?: ReactNode;
}

/** Shared loading / empty / error block so every async path looks and reads the same. */
export function StatusMessage({ kind, title, detail, action }: StatusMessageProps) {
  return (
    // Errors interrupt (alert); loading/empty are polite status updates.
    <div className={`status-message status-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'loading' && <span className="spinner" aria-hidden="true" />}
      <div className="status-title">{title}</div>
      {detail && <div className="status-detail">{detail}</div>}
      {action}
    </div>
  );
}

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/* ---------------------------------------------------------------- icons */

export type IconName =
  | 'overview' | 'inbox' | 'catalog' | 'wizard' | 'settings' | 'graph' | 'task'
  | 'play' | 'pause' | 'check' | 'alert' | 'clock' | 'plus' | 'refresh'
  | 'link' | 'bolt' | 'spark' | 'box' | 'chevron' | 'search' | 'message' | 'send' | 'close'
  | 'folder' | 'file' | 'paperclip' | 'archive' | 'panel-left' | 'panel-right';

const PATHS: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  inbox: <><path d="M4 13.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7.5" /><path d="M4 13.5h4l1.5 2h5L16 13.5h4V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></>,
  catalog: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v14H6.5A2.5 2.5 0 0 0 4 19.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H19v-5" /></>,
  wizard: <><path d="M5 3v4M3 5h4M17 15v4M15 17h4" /><path d="M14.5 3.5 20.5 9.5 9.5 20.5H3.5v-6z" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.14A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.13 4.14l.06.06A1.7 1.7 0 0 0 9 4.54h.08A1.7 1.7 0 0 0 10.1 3V3a2 2 0 1 1 4 0v.14a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.14a1.7 1.7 0 0 0-1.46 1.03z" /></>,
  graph: <><circle cx="6" cy="6" r="2.6" /><circle cx="18" cy="7" r="2.6" /><circle cx="12" cy="18" r="2.6" /><path d="M8.2 7 10 15.6M15.8 8.2 13.9 15.6" /></>,
  task: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1.4" /><circle cx="4.5" cy="12" r="1.4" /><circle cx="4.5" cy="18" r="1.4" /></>,
  play: <path d="M7 4.5v15l12-7.5z" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></>,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  alert: <><path d="M12 3 2.5 20h19z" /><path d="M12 9.5v4.5M12 17.2v.1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.4 2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" /><path d="M20 4v4h-4" /><path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" /><path d="M4 20v-4h4" /></>,
  link: <><path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.3 1.3" /><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.3-1.3" /></>,
  bolt: <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z" />,
  spark: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m5.6 5.6 2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></>,
  box: <><path d="M12 3 3 7.5v9L12 21l9-4.5v-9z" /><path d="m3 7.5 9 4.5 9-4.5M12 12v9" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
  message: <><path d="M5 18.5 3.5 21l3.7-1a8 8 0 1 0-2.2-1.5" /><path d="M8 10.5h8M8 14h5" /></>,
  send: <><path d="m4 4 17 8-17 8 3.2-8z" /><path d="M7.2 12H21" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  folder: <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h3l2 2h7A2.5 2.5 0 0 1 20.5 8.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />,
  file: <><path d="M6 2.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V4A1.5 1.5 0 0 1 6.5 2.5z" /><path d="M13 2.5v5h5" /></>,
  paperclip: <path d="m20.5 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M9 13h6" /></>,
  'panel-left': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  'panel-right': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
};

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/* ---------------------------------------------------------------- button */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
};

export function Button({ variant = 'default', size = 'md', icon, className = '', children, ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' ? `btn-${variant}` : '', size !== 'md' ? `btn-${size}` : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={classes} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
      {icon && children ? <span style={{ marginLeft: 6 }}>{children}</span> : children}
    </button>
  );
}

/* ---------------------------------------------------------------- cards */

export function Card({ title, icon, subtitle, actions, children, className = '', testid, tone }: {
  title?: ReactNode; icon?: IconName; subtitle?: ReactNode; actions?: ReactNode;
  children: ReactNode; className?: string; testid?: string; tone?: 'accent' | 'success' | 'warn' | 'danger' | 'info';
}) {
  return (
    <section className={`card ${className}`} data-testid={testid} data-tone={tone}>
      {(title || actions) && (
        <header className="card-head">
          <div className="card-title">{icon && <Icon name={icon} />}{title}</div>
          {subtitle && <span className="card-sub">{subtitle}</span>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Pill({ tone = 'neutral', children, testid }: { tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | undefined; children: ReactNode; testid?: string | undefined }) {
  return <span className="pill" data-tone={tone} data-testid={testid}>{children}</span>;
}

export function StatusDot({ tone = 'neutral', pulse = false }: { tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | undefined; pulse?: boolean | undefined }) {
  return <span className="dot" data-tone={tone} data-pulse={pulse ? 'true' : 'false'} />;
}

export function Stat({ label, value, hint, tone, progress, testid }: {
  label: string; value: ReactNode; hint?: ReactNode | undefined;
  tone?: 'success' | 'warn' | 'danger' | undefined; progress?: number | undefined; testid?: string | undefined;
}) {
  return (
    <div className="stat" data-tone={tone} data-testid={testid}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
      {progress !== undefined && <div className="bar"><div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></div>}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode | undefined; error?: string | undefined; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <span className="field-hint"> · {hint}</span>}</span>
      {children}
      {error && <span className="field-error" data-testid={`field-error-${label}`}>{error}</span>}
    </label>
  );
}

export function Empty({ icon = 'box', title, hint }: { icon?: IconName; title: string; hint?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={22} /></div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="muted"><span className="spinner" />{label ?? '加载中…'}</span>;
}

/* ---------------------------------------------------------------- toasts */

type ToastTone = 'info' | 'success' | 'danger';
type ToastItem = { id: number; message: string; tone: ToastTone };

let toastId = 0;
const toastListeners = new Set<(item: ToastItem) => void>();

export function toast(message: string, tone: ToastTone = 'info') {
  const item = { id: ++toastId, message, tone };
  for (const listener of toastListeners) listener(item);
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const listener = (item: ToastItem) => {
      setItems(current => [...current, item]);
      setTimeout(() => setItems(current => current.filter(entry => entry.id !== item.id)), 3_600);
    };
    toastListeners.add(listener);
    return () => { toastListeners.delete(listener); };
  }, []);
  return (
    <div className="toasts" data-testid="toasts">
      {items.map(item => (
        <div key={item.id} className="toast" data-tone={item.tone} role="status">
          <StatusDot tone={item.tone === 'danger' ? 'danger' : item.tone === 'success' ? 'success' : 'info'} />
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}

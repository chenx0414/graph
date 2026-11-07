import { useEffect, useRef } from 'react';
import { Icon } from './ui.tsx';
import type { WorkspaceTabs } from './workspace-tabs.ts';

export function TabBar({ state, onActivate, onClose }: {
  state: WorkspaceTabs;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    bar.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state.activeId]);
  return (
    <nav ref={bar} className="tab-bar" data-testid="tab-bar" aria-label="打开的窗口">
      {state.tabs.map((tab, index) => {
        const active = tab.id === state.activeId;
        return (
          <div
            key={tab.id}
            className="tab"
            data-active={active}
            data-kind={tab.kind}
            data-tab-key={tab.key}
            data-testid={`tab-${index}`}
          >
            <button
              type="button"
              className="tab-open"
              data-testid={`tab-open-${index}`}
              aria-current={active ? 'page' : undefined}
              title={`${tab.title}${index < 8 ? ` · ⌘${index + 1}` : ''}`}
              onClick={() => onActivate(tab.id)}
            >
              <span className="tab-title">{tab.title}</span>
            </button>
            <button
              type="button"
              className="tab-close"
              data-testid={`tab-close-${index}`}
              aria-label={`关闭 ${tab.title}`}
              title={`关闭 ${tab.title} · ⌘W`}
              onClick={() => onClose(tab.id)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
      {!state.tabs.length && <span className="tab-hint" data-testid="tab-bar-empty">没有打开的窗口</span>}
    </nav>
  );
}

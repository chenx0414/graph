import { Icon, type IconName } from './ui.tsx';

// The welcome block is shared: the new-conversation page and an empty
// conversation show the same guidance instead of one of them being a blank page.
export function ChatIntro({ eyebrow, title, body }: { eyebrow?: string; title: string; body: string }) {
  return (
    <div className="new-chat-intro">
      <div className="new-chat-mark" aria-hidden="true" />
      <span className="new-chat-eyebrow">{eyebrow ?? '从一个目标，开始协作'}</span>
      <h1>{title}</h1>
      <p>{body}</p>
    </div>
  );
}

export const STARTER_TASKS = [
  { icon: 'search', title: '了解项目', hint: '梳理结构，找到改进方向', prompt: '帮我梳理这个项目的结构与主要流程，找出值得优先改进的地方。' },
  { icon: 'bolt', title: '解决问题', hint: '描述现象，一起定位原因', prompt: '我遇到了一个问题，请先帮我分析原因，并告诉我需要补充哪些信息：' },
  { icon: 'graph', title: '开发功能', hint: '从想法到可执行的方案', prompt: '我想给这个项目添加一项功能，请先帮我明确需求和验收条件，再制定方案：' },
] satisfies { icon: IconName; title: string; hint: string; prompt: string }[];

export function StarterCards({ onPick, disabled = false }: { onPick: (prompt: string) => void; disabled?: boolean }) {
  return (
    <div className="starter-grid" aria-label="试试这些任务">
      {STARTER_TASKS.map(item => (
        <button
          type="button"
          className="starter-card"
          key={item.title}
          disabled={disabled}
          onClick={() => onPick(item.prompt)}
        >
          <Icon name={item.icon} size={18} /><strong>{item.title}</strong><span>{item.hint}</span>
        </button>
      ))}
    </div>
  );
}

export function OnboardingSteps() {
  return (
    <ol className="onboarding-steps" aria-label="协作流程">
      <li><span>1</span>描述目标</li><li><span>2</span>确认方案草稿</li><li><span>3</span>在任务图中跟进</li>
    </ol>
  );
}

import { Icon } from './ui.tsx';
import type { TranscriptRow } from './transcript-model.ts';

function CompactionNotice({ row }: { row: Extract<TranscriptRow, { kind: 'compaction' }> }) {
  return (
    <div className="compaction-notice" data-testid="compaction-notice" data-role="system">
      <div className="compaction-notice-head" title={row.text}>
        <span className="compaction-notice-rule" aria-hidden="true" />
        <span className="compaction-notice-text">
          <Icon name="archive" size={13} />
          上下文已压缩
        </span>
        <span className="compaction-notice-rule" aria-hidden="true" />
      </div>
      {row.summary && (
        <div className="compaction-summary" data-testid="compaction-summary">{row.summary}</div>
      )}
    </div>
  );
}

export { CompactionNotice };

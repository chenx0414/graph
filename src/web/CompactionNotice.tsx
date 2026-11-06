import { Icon } from './ui.tsx';
import type { TranscriptRow } from './transcript-model.ts';

/** One muted line where the kernel replaced the earlier context with a summary.
 *
 * The transcript keeps every message; this row only says that the agent's context
 * shrank, and that the earlier conversation is still readable through history
 * search. It is a divider, not a message from either side of the chat. */
function CompactionNotice({ row }: { row: Extract<TranscriptRow, { kind: 'compaction' }> }) {
  return (
    <div className="compaction-notice" data-testid="compaction-notice" data-role="system" title={row.text}>
      <span className="compaction-notice-rule" aria-hidden="true" />
      <span className="compaction-notice-text">
        <Icon name="archive" size={13} />
        {row.text}
      </span>
      <span className="compaction-notice-rule" aria-hidden="true" />
    </div>
  );
}

export { CompactionNotice };

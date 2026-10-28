import { createPortal } from 'react-dom';
import { ConversationDrawerView } from "./conversation-drawer-view.tsx";
import { WorkDrafts } from './WorkDrafts.tsx';

import { WindowDrawer } from './WindowDrawer.tsx';








import { ChatComposer } from './ChatComposer.tsx';

import { attachmentImageSource } from './attachments.ts';

import {
composerPrimaryDisabled
} from './composer-state.ts';

import { markdownEnabled } from './preferences.ts';

import { ComposerTelemetry } from './ComposerTelemetry.tsx';


import {
messageAttachments
} from '../core/conversation-projection.ts';

import { formatTokens } from './insights.ts';

import {
drawerEntryAriaLabel,
residentPanelIds
} from './conversation-drawer.ts';

import './conversation-drawer.css';

import { NODE_LABEL } from './labels.ts';


import { QuestionReply } from './Questions.tsx';

import { ErrorBox,costText } from './shared.tsx';

import { TranscriptRowView } from './TranscriptRows.tsx';

import { Icon } from './ui.tsx';


import { useConversationPanelState } from "./conversation-state.tsx";
import { residentFlag } from "./conversation-types.tsx";

export function ConversationPanelView({ sending, steering, view, busy, paused, connected, drawerOpen, draftStatus, tasks, onDrawerOpenChange, openDrawerRoot, entryState, proposal, acceptedVersions, transcriptFollow, loadOlder, snapshot, loadingOlder, transcriptRows, preferences, actionError, queuedMessages, cancelQueued, masterQuestions, taskQuestions, reload, onChanged, text, setText, attachments, setAttachments, promptSuggestion, agentContext, settings, selectMasterModel, compactConversation, submitPrimary, submitEnter, composerHistory, Boolean, pauseAction, hasComposerInput, drawerSection, deferredInitPanelIds, bindId, setBindId, act, id, activeProposal, activeStale, activeAccepted, confirmableForActive, branch, setBranch, setSelectedProposalVersion, selectedProposalVersion, proposalHistory, managementCards, drawerLoading, selectedTaskId, setSelectedTaskId, hasDrawerContent }: Extract<ReturnType<typeof useConversationPanelState>, { fallback: null }>) {
return (
    <section className="conversation-page" data-testid="conversation">
      {document.getElementById('conversation-toolbar') && createPortal(<div className="conversation-toolbar-content">
        <div className="conversation-heading">
          <h1 data-testid="conversation-title">{view.title}</h1>
          <div className="conversation-meta" title={`已计量 ${formatTokens(view.usage.used)} tokens · ${costText(view.cost)}`}>
            {view.projectId ? <span data-testid="conversation-project">项目 {view.projectId}</span> : <span data-testid="conversation-project">未绑定项目</span>}
            <span>·</span>
            <span data-testid="master-status" className="master-work-status">{busy && !paused && <span className="spinner" aria-hidden="true" />}{paused ? '已暂停' : busy ? '正在处理…' : view.master ? NODE_LABEL[view.master.status] ?? view.master.status : '未配置'}</span>
            <span>·</span>
            <span data-testid="conversation-connection">{connected ? '已连接' : '重连中…'}</span>

          </div>
        </div>
        <div className="conversation-actions">
          <button
            type="button"
            className="drawer-entry"
            data-testid="drawer-entry"
            data-open={drawerOpen}
            data-draft-status={draftStatus}
            data-task-count={tasks.length}
            onClick={() => drawerOpen ? onDrawerOpenChange(false) : openDrawerRoot()}
            title={drawerEntryAriaLabel(entryState)}
            aria-label={drawerEntryAriaLabel(entryState)}
            aria-expanded={drawerOpen}
            aria-controls="conversation-detail-drawer"
          >
            <Icon name="panel-right" size={15} />
            <span className="drawer-entry-label" data-testid="drawer-entry-label">{proposal && !acceptedVersions.has(proposal.version) ? `草稿 v${proposal.version}` : `任务 ${view.tasks.length}`}</span>
            {(draftStatus === 'pending' || draftStatus === 'stale') && <span className="drawer-entry-dot" data-tone={draftStatus === 'stale' ? 'warn' : 'accent'} aria-hidden="true" />}
          </button>
          {/* The pause/resume control lives on the composer's primary button
              (same action, same flag); the header no longer repeats it. */}

        </div>
      </div>, document.getElementById('conversation-toolbar')!)}

      {paused && (
        <section className="conversation-alert" data-testid="conversation-paused-notice">
          <div className="conversation-pause-note">
            <Icon name="pause" size={15} />
            <span><strong>主 Agent 对话已暂停。</strong> 正在跑的回合会在当前工具调用收尾后停下，不再发起新的模型请求；新消息会保留并排队。继续后会接着跑被停下的那个回合。</span>
          </div>
        </section>
      )}

      {/* The chat column is the conversation: its artifacts live in the drawer, and a single
          artifact opens as its own tab. */}
      <div className="conversation-body" data-drawer={drawerOpen} data-view="chat" data-resident-panels={residentPanelIds().join(' ')}>
        <div className="conversation-main">
          <div className="conversation-thread-shell">
          <div
            className="conversation-thread"
            data-testid="message-list"
            data-pinned={transcriptFollow.pinned}
            ref={transcriptFollow.threadRef}
            onScroll={() => {
              transcriptFollow.onScroll();
              const thread = transcriptFollow.threadRef.current;
              if (thread && thread.scrollTop < 160 && !transcriptFollow.pinned) void loadOlder();
            }}
            onWheel={transcriptFollow.onWheel}
            onTouchStart={transcriptFollow.onTouchStart}
          >
          <div className="conversation-thread-inner" ref={transcriptFollow.contentRef}>
          {snapshot.historyRequest && <button type="button" className="btn btn-sm" data-testid="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '加载中…' : '载入更早消息'}</button>}
          {transcriptRows.map(row => <TranscriptRowView key={row.id} row={row} markdown={markdownEnabled(preferences)} />)}
          <WorkDrafts role={view.role} conversationId={id} projectId={view.projectId} projects={settings?.projects ?? []} cursor={view.cursor} />

          <div className="conversation-runway" style={{ height: transcriptFollow.runway }} aria-hidden="true" />
          </div>
          </div>
          {transcriptFollow.showJump && (
            <button
              type="button"
              className="jump-to-latest"
              data-testid="jump-to-latest"
              onClick={() => transcriptFollow.scrollToLatest('smooth')}
            >
              <Icon name="chevron" size={13} />
              回到最新
            </button>
          )}
          </div>

          <div className="conversation-composer-wrap">
            {actionError && <ErrorBox message={actionError} />}
            {queuedMessages.length > 0 && (
              <div className="queued-messages" data-testid="queued-messages">
                {queuedMessages.map((message, index) => {
                  const attachments = messageAttachments(message);
                  return (
                    <div className="queued-message" data-testid="queued-message" key={message.id}>
                      <div className="queued-message-body">
                        {message.text && <p>{message.text}</p>}
                        {attachments.length > 0 && (
                          <div className="queued-message-attachments">
                            {attachments.map(attachment => (
                              <span key={`${attachment.name}:${attachment.size}`}>
                                {attachmentImageSource(attachment) ? <img className="message-attachment-image" src={attachmentImageSource(attachment)} alt={attachment.name} /> : <Icon name="paperclip" size={11} />}
                                {attachment.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="queued-message-order">{index + 1}</span>
                      <button
                        type="button"
                        className="queued-message-cancel"
                        data-testid="queued-message-cancel"
                        onClick={() => void cancelQueued(message.id)}
                        aria-label="取消这条排队消息"
                        title="取消这条排队消息"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {(masterQuestions.length > 0 || taskQuestions.length > 0) ? (
              <section className="conversation-question-composer" data-testid="conversation-questions" data-resident={residentFlag('conversation-questions')} aria-label="等待你确认">
                <div className="thread-card-title">需要你的答复</div>
                <ul className="list" data-testid="master-questions-list">
                  {masterQuestions.map(question => <QuestionReply key={question.id} taskId={question.taskId} question={question} onDone={() => { void reload(); onChanged?.(); }} />)}
                  {taskQuestions.map(task => <li key={task.id} className="conversation-question-group" data-testid={`conversation-questions-${task.id}`}>
                    <div className="muted">{task.request}</div>
                    <ul className="list">{task.openQuestions.map(question => <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => { void reload(); onChanged?.(); }} />)}</ul>
                  </li>)}
                </ul>
              </section>
            ) : <ChatComposer
              className="conversation-composer"
              value={text}
              onChange={setText}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              projectId={view.projectId}
              placeholder={busy ? '继续输入，消息会排队…' : '发送消息，@ 引用文件…'}
              suggestion={promptSuggestion}
              slashTools={agentContext?.tools ?? []}
              slashCapabilities={agentContext?.capabilities ?? []}
              slashModels={settings?.models ?? []}
              slashTelemetry={view.telemetry}
              onSlashModelSelect={selectMasterModel}
              onCompact={compactConversation}
              onSend={() => void submitPrimary()}
              onSubmit={() => void submitEnter()}
              history={composerHistory}
              busy={Boolean(busy)}
              paused={paused}
              pausePending={pauseAction !== null}
              queueLength={queuedMessages.length}
              hasSuggestion={Boolean(promptSuggestion)}
              sendDisabled={composerPrimaryDisabled({
                sending, steering,
                pending: pauseAction !== null,
                paused,
                busy: Boolean(busy),
                hasInput: hasComposerInput,
                hasSuggestion: Boolean(promptSuggestion),
              })}
            />}
            {masterQuestions.length === 0 && taskQuestions.length === 0 && <div className="composer-footer">
              <span className="composer-note">
                {busy
                  ? <span data-testid="queued-hint">{queuedMessages.length ? `${queuedMessages.length} 条消息等待处理` : '可继续输入'}</span>
                  : 'Enter 发送，Shift + Enter 换行'}
              </span>
              <ComposerTelemetry
                telemetry={view.telemetry}
                models={settings?.models ?? []}
                onSelect={selectMasterModel}
              />
            </div>}
          </div>
        </div>

        <WindowDrawer open={drawerOpen}>
        <ConversationDrawerView {...{ drawerOpen, drawerSection, proposal, view, deferredInitPanelIds, bindId, setBindId, settings, act, id, activeProposal, activeStale, activeAccepted, confirmableForActive, branch, setBranch, setSelectedProposalVersion, selectedProposalVersion, proposalHistory, managementCards, drawerLoading, tasks, selectedTaskId, setSelectedTaskId, hasDrawerContent }} />
        </WindowDrawer>
      </div>
    </section>
  );
}

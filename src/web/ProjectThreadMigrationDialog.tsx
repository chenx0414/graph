import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { Button, Icon } from './ui.tsx';

type MigrationSource = {
  conversationId: string;
  title: string;
  activeGraphs: number;
  activeTurns: number;
  pendingChats: number;
  blockedChats: number;
  pendingPeers: number;
  pendingWakes: number;
  legacyWork: number;
};
type MigrationPreview = { selectedTitle: string; restoreSelected: boolean; sources: MigrationSource[] };

export function ProjectThreadMigrationDialog({ projectId, conversationId, onClose, onConfirm }: {
  projectId: string;
  conversationId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const trigger = document.activeElement;
    dialog.current?.showModal();
    let current = true;
    void api<MigrationPreview>(`/api/projects/${encodeURIComponent(projectId)}/thread/preview?conversationId=${encodeURIComponent(conversationId)}`)
      .then(value => { if (current) setPreview(value); })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => {
      current = false;
      dialog.current?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [projectId, conversationId]);
  const blocked = preview?.sources.some(source => source.activeTurns > 0 || source.blockedChats > 0 || source.legacyWork > 0) ?? true;
  return createPortal(
    <dialog ref={dialog} className="project-modal" aria-labelledby="migration-title" onCancel={event => { event.preventDefault(); onClose(); }}>
      <div className="modal-card project-dialog" data-testid="project-thread-migration-preview">
        <div className="modal-head"><h2 id="migration-title">选择项目主管对话</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" size={16} /></button></div>
        {error ? <p role="alert">无法读取迁移预览：{error}</p> : !preview ? <p>正在读取迁移预览…</p> : <>
          <p>将“{preview.selectedTitle}”设为 {projectId} 的长期主管对话。其他对话保留为历史，未完成的 graph 转交给该主管。</p>
          {preview.restoreSelected && <p>选择的对话将从归档中恢复。</p>}
          {preview.sources.map(source => <div key={source.conversationId}>
            <strong>{source.title}</strong>
            <p>未完成 graph：{source.activeGraphs}；待转交节点消息：{source.pendingPeers}；待转交对话消息：{source.pendingChats - source.blockedChats}；待处理通知：{source.pendingWakes}。</p>
            {(source.activeTurns > 0 || source.blockedChats > 0 || source.legacyWork > 0) && <p role="alert">需要先处理：运行中的对话 {source.activeTurns}，暂停或无法转交的对话消息 {source.blockedChats}，旧版未完成工作 {source.legacyWork}。</p>}
          </div>)}
          <p>切换时会重新检查状态；无法安全归属的通知会阻止切换。</p>
        </>}
        <div className="modal-actions"><Button type="button" onClick={onClose}>取消</Button><Button type="button" disabled={blocked || Boolean(error)} onClick={onConfirm}>确认选择</Button></div>
      </div>
    </dialog>, document.body,
  );
}

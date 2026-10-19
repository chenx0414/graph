import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { Button, Icon } from './ui.tsx';

type Project = { id: string; root: string; grants?: string[] };
type Credential = { secretRef: string; displayName?: string; sharedLimitGroupId?: string; configured?: boolean };
type ConfigResponse = {
  revision: number;
  config: {
    projects?: Project[];
    models?: unknown;
    credentials?: Record<string, Credential>;
    limits?: unknown;
  };
};

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

export function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const bridge = typeof window !== 'undefined' ? window.graph : undefined;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement>('#project-name')?.focus();
    return () => {
      dialog.current?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function chooseRoot() {
    setError('');
    const picked = await bridge?.pickDirectory();
    if (!picked) return;
    setRoot(picked);
    if (!name.trim()) setName(folderName(picked));
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const id = name.trim();
    const projectRoot = root.trim();
    if (!id) { setError('请输入项目名称'); return; }
    if (!projectRoot) { setError('请选择源文件夹'); return; }
    setBusy(true);
    setError('');
    try {
      const current = await api<ConfigResponse>('/api/config');
      const existing = current.config.projects ?? [];
      if (existing.some(project => project.id === id)) {
        setError(`项目 ${id} 已存在`);
        return;
      }
      const credentials = Object.fromEntries(
        Object.entries(current.config.credentials ?? {}).map(([credentialId, credential]) => {
          const { configured: _configured, ...rest } = credential;
          return [credentialId, rest];
        }),
      );
      const document = {
        version: 1,
        projects: [...existing, { id, root: projectRoot }],
        ...(current.config.models ? { models: current.config.models } : {}),
        credentials,
        ...(current.config.limits ? { limits: current.config.limits } : {}),
      };
      const saved = await api<{ applied?: boolean; reason?: string }>('/api/config', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: current.revision, document }),
      });
      if (saved.applied === false) throw new Error(saved.reason ?? '配置未生效');
      onCreated();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <dialog ref={dialog} className="project-modal" aria-labelledby="project-dialog-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal-card project-dialog" data-testid="create-project-dialog" onSubmit={event => void create(event)}>
        <div className="modal-head">
          <h2 id="project-dialog-title">创建项目</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </div>
        <label className="field-label" htmlFor="project-name">项目名称</label>
        <label className="project-input-row">
          <Icon name="box" size={17} />
          <input
            id="project-name"
            name="project-name"
            required
            data-testid="project-name"
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="例如：我的网站"
          />
        </label>
        <label className="field-label" htmlFor={bridge ? "project-pick" : "project-root"}>源文件夹</label>
        <p className="field-hint">选择要协作的项目目录，现有文件会保留。</p>
        <div className="source-picker">
          {bridge ? (
            <>
              <button type="button" id="project-pick" className="source-picker-trigger" data-testid="project-pick" onClick={() => void chooseRoot()}>
                <span>{root || '在此电脑上添加文件夹'}</span>
                <Icon name="chevron" size={14} />
              </button>
              <Button type="button" size="sm" icon="folder" onClick={() => void chooseRoot()}>添加</Button>
            </>
          ) : (
            <input
              className="input"
              id="project-root"
              name="project-root"
              required
              data-testid="project-root"
              value={root}
              onChange={event => setRoot(event.target.value)}
              placeholder="/path/to/project"
            />
          )}
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <Button type="button" variant="ghost" data-testid="project-cancel" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" data-testid="project-create" disabled={busy}>
            {busy ? '创建中…' : '创建项目'}
          </Button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

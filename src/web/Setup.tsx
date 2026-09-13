import { useEffect, useState } from 'react';
import { api } from './api.ts';
import {
  SETUP_TEMPLATES, buildConfigDocument, defaultSecretRef, defaultSetupForm,
  setupFieldFor, validateSetup, type SetupForm, type SetupTemplate,
} from './setup.ts';
import { Button, Card, Field, Pill, toast } from './ui.tsx';

const fieldError = (errors: Record<string, string>, key: string) => errors[key];

export function Setup() {
  const [form, setForm] = useState<SetupForm>(defaultSetupForm);
  const [revision, setRevision] = useState<number | null>(null);
  const [hasContent, setHasContent] = useState(false);
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bridge = typeof window !== 'undefined' ? window.graph : undefined;

  useEffect(() => {
    void api<{ revision: number; config: { projects?: unknown[]; models?: { entries?: unknown[] } | null; credentials?: Record<string, unknown> } }>('/api/config')
      .then(result => {
        setRevision(result.revision);
        setHasContent(Boolean(
          (result.config.projects?.length ?? 0) > 0
          || (result.config.models?.entries?.length ?? 0) > 0
          || Object.keys(result.config.credentials ?? {}).length > 0,
        ));
      })
      .catch(error => setStatus(`读取配置失败：${(error as Error).message}`));
  }, []);

  const patch = (values: Partial<SetupForm>) => setForm(current => ({ ...current, ...values }));

  async function pickRoot() {
    const picked = await bridge?.pickDirectory();
    if (picked) patch({ projectRoot: picked, projectId: form.projectId || picked.split('/').filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'demo' });
  }

  async function submit() {
    const found = validateSetup(form);
    setErrors(found);
    setStatus(null);
    if (Object.keys(found).length) {
      toast('请先修正表单中的错误', 'danger');
      return;
    }
    if (revision === null) {
      setStatus('当前守护进程未绑定配置文件；CLI 模式下请先创建 graph.config.json 再打开本页。');
      return;
    }
    setBusy(true);
    try {
      if (bridge && key.trim()) {
        const stored = await bridge.saveSecret(form.secretRef, key.trim());
        if (!stored.stored) setStatus(`密钥未写入系统钥匙串：${stored.message ?? '存储不可用'}，将依赖环境变量。`);
      }
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: revision, document: buildConfigDocument({ version: 1 }, form) }),
      });
      if (bridge) {
        const result = await bridge.relaunch();
        setStatus(`已保存并重启守护进程：${result.url}${key.trim() ? '' : '（未填写密钥，仍为仅查看模式）'}`);
        toast('配置已保存，守护进程已重启', 'success');
        setTimeout(() => location.assign(result.url), 600);
      } else {
        setStatus('已保存。请以 --execute 重启守护进程使配置生效；密钥需通过环境变量提供。');
        toast('配置已保存', 'success');
      }
    } catch (error) {
      const failure = error as Error & { field?: string; code?: string };
      const target = setupFieldFor(failure.field);
      setErrors(target ? { [target]: failure.message } : {});
      setStatus(target ? null : `保存失败（${failure.code ?? 'error'}）：${failure.message}`);
      toast(`保存失败：${failure.message}`, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stagger" data-testid="setup">
      <Card title="配置向导" icon="wizard" subtitle={bridge ? '密钥写入系统钥匙串，保存后自动重启守护进程' : '浏览器模式：密钥通过环境变量提供'}>
        <p className="muted">
          填写项目与模型后保存。{bridge ? '桌面 APP 会把密钥写入系统钥匙串并自动重启守护进程。' : '命令行模式需要自己设置凭据引用的环境变量，然后以 --execute 重启。'}
        </p>
        {status && <div data-testid="setup-status" className="hint-card" style={{ display: 'block' }}>{status}</div>}
        {hasContent && (
          <div data-testid="setup-existing" className="banner" style={{ borderRadius: 12, margin: '10px 0' }}>
            已有配置。为避免覆盖，向导只用于首次配置；平时请到<a href="#/settings">设置页</a>增删项目、模型与凭据。
          </div>
        )}
        {!hasContent && <>
          <h3 className="section-title">项目</h3>
          <Field label="项目 id" error={fieldError(errors, 'projectId')}>
            <input className="input" data-testid="setup-project-id" data-invalid={Boolean(errors.projectId)} value={form.projectId} onChange={event => patch({ projectId: event.target.value })} placeholder="demo" />
          </Field>
          <Field label="项目路径" hint="被编排项目的根目录">
            <div className="row">
              <input className="input" style={{ flex: 1, minWidth: 260, maxWidth: 'none' }} data-testid="setup-project-root" data-invalid={Boolean(errors.projectRoot)} value={form.projectRoot} onChange={event => patch({ projectRoot: event.target.value })} placeholder="/path/to/project" />
              {bridge && <Button icon="box" onClick={() => void pickRoot()}>选择目录</Button>}
            </div>
          </Field>

          <h3 className="section-title">模型</h3>
          <Field label="模板">
            <select className="select" value={form.template} onChange={event => patch({ template: event.target.value as SetupTemplate, ...SETUP_TEMPLATES[event.target.value as SetupTemplate] })}>
              <option value="local">本地 OpenAI 兼容（如 Ollama / LM Studio）</option>
              <option value="custom">远程 OpenAI 兼容</option>
            </select>
          </Field>
          <div className="card-grid">
            <Field label="模型 id" error={fieldError(errors, 'modelId')}>
              <input className="input" data-testid="setup-model-id" data-invalid={Boolean(errors.modelId)} value={form.modelId} onChange={event => patch({ modelId: event.target.value })} />
            </Field>
            <Field label="provider 标签" hint="同一标签共享端点与凭据" error={fieldError(errors, 'provider')}>
              <input className="input" data-testid="setup-provider" value={form.provider} onChange={event => patch({ provider: event.target.value })} />
            </Field>
            <Field label="等级">
              <select className="select" value={form.grade} onChange={event => patch({ grade: event.target.value as SetupForm['grade'] })}>
                {['low', 'medium', 'high', 'highest'].map(grade => <option key={grade} value={grade}>{grade}</option>)}
              </select>
            </Field>
            <Field label="上下文窗口" error={fieldError(errors, 'contextWindow')}>
              <input className="input" type="number" data-testid="setup-context-window" data-invalid={Boolean(errors.contextWindow)} value={String(form.contextWindow)} onChange={event => patch({ contextWindow: Number(event.target.value) })} />
            </Field>
            <Field label="最大输出" error={fieldError(errors, 'maxTokens')}>
              <input className="input" type="number" data-testid="setup-max-tokens" data-invalid={Boolean(errors.maxTokens)} value={String(form.maxTokens)} onChange={event => patch({ maxTokens: Number(event.target.value) })} />
            </Field>
          </div>
          <Field label="端点" error={fieldError(errors, 'baseUrl')}>
            <input className="input" style={{ maxWidth: 'none' }} data-testid="setup-base-url" data-invalid={Boolean(errors.baseUrl)} value={form.baseUrl} onChange={event => patch({ baseUrl: event.target.value })} />
          </Field>

          <h3 className="section-title">凭据</h3>
          <div className="card-grid">
            <Field label="凭据 id" error={fieldError(errors, 'credentialId')}>
              <input className="input" data-testid="setup-credential-id" data-invalid={Boolean(errors.credentialId)} value={form.credentialId} onChange={event => {
                const previous = defaultSecretRef(form.credentialId);
                patch({ credentialId: event.target.value, ...(form.secretRef === previous ? { secretRef: defaultSecretRef(event.target.value) } : {}) });
              }} />
            </Field>
            <Field label="凭据引用" hint="配置文件中只会出现这个名字" error={fieldError(errors, 'secretRef')}>
              <input className="input" data-testid="setup-secret-ref" value={form.secretRef} onChange={event => patch({ secretRef: event.target.value })} />
            </Field>
          </div>
          {bridge
            ? <Field label="API 密钥" hint="仅写入系统钥匙串，不进入配置文件">
                <input className="input" style={{ maxWidth: 'none' }} type="password" data-testid="setup-key" value={key} onChange={event => setKey(event.target.value)} placeholder="sk-…（可留空，稍后在设置中补充）" />
              </Field>
            : <p className="muted">请设置环境变量 <code>{form.secretRef}</code> 后重启守护进程。</p>}

          <div className="row" style={{ marginTop: 16 }}>
            <Button variant="primary" size="lg" icon="check" disabled={busy || revision === null} onClick={() => void submit()} data-testid="setup-save">
              {busy ? '保存中…' : bridge ? '保存并重启' : '保存配置'}
            </Button>
            {revision !== null && <Pill>已保存 revision {revision}</Pill>}
          </div>
        </>}
      </Card>
    </div>
  );
}

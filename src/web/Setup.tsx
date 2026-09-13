import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import {
  SETUP_TEMPLATES, buildConfigDocument, defaultSecretRef, defaultSetupForm,
  setupFieldFor, validateSetup, type SetupForm, type SetupTemplate,
} from './setup.ts';

const field = (label: string, node: ReactNode, error?: string, hint?: string) => (
  <p style={{ margin: '6px 0' }}>
    <label>{label}<br />{node}{hint && <small style={{ color: '#666', marginLeft: 8 }}>{hint}</small>}</label>
    {error && <span data-testid={`error-${label}`} style={{ color: '#b91c1c', marginLeft: 8 }}>{error}</span>}
  </p>
);

const input = (value: string, onChange: (value: string) => void, type = 'text', placeholder?: string, testid?: string) => (
  <input data-testid={testid} type={type} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} style={{ width: 320 }} />
);

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
    if (Object.keys(found).length) return;
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
        setTimeout(() => location.assign(result.url), 600);
      } else {
        setStatus('已保存。请以 --execute 重启守护进程使配置生效；密钥需通过环境变量提供。');
      }
    } catch (error) {
      const failure = error as Error & { field?: string; code?: string };
      const target = setupFieldFor(failure.field);
      setErrors(target ? { [target]: failure.message } : {});
      setStatus(target ? null : `保存失败（${failure.code ?? 'error'}）：${failure.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="setup" style={{ maxWidth: 720 }}>
      <h2>配置向导</h2>
      <p style={{ color: '#555' }}>
        填写项目与模型后保存。{bridge ? '桌面 APP 会把密钥写入系统钥匙串并自动重启守护进程。' : '命令行模式需要自己设置凭据引用的环境变量，然后以 --execute 重启。'}
      </p>
      {status && <p data-testid="setup-status" style={{ background: '#eef3fb', border: '1px solid #b9cbe8', padding: '6px 8px' }}>{status}</p>}
      {hasContent && (
        <p data-testid="setup-existing" style={{ background: '#fff4d6', border: '1px solid #e7c66b', padding: '6px 8px' }}>
          已有配置。为避免覆盖，向导只用于首次配置；平时请到<a href="#/settings">设置页</a>增删项目、模型与凭据。
        </p>
      )}
      {!hasContent && <>
      <h3>项目</h3>
      {field('项目 id', input(form.projectId, value => patch({ projectId: value }), 'text', 'demo', 'setup-project-id'), errors.projectId)}
      {field(
        '项目路径',
        <>
          {input(form.projectRoot, value => patch({ projectRoot: value }), 'text', '/path/to/project', 'setup-project-root')}
          {bridge && <button type="button" onClick={() => void pickRoot()} style={{ marginLeft: 8 }}>选择目录</button>}
        </>,
        errors.projectRoot,
      )}

      <h3>模型</h3>
      <p style={{ margin: '6px 0' }}>
        <label>模板
          <select
            value={form.template}
            onChange={event => patch({ template: event.target.value as SetupTemplate, ...SETUP_TEMPLATES[event.target.value as SetupTemplate] })}
            style={{ marginLeft: 8 }}
          >
            <option value="local">本地 OpenAI 兼容（如 Ollama / LM Studio）</option>
            <option value="custom">远程 OpenAI 兼容</option>
          </select>
        </label>
      </p>
      {field('模型 id', input(form.modelId, value => patch({ modelId: value }), 'text', undefined, 'setup-model-id'), errors.modelId)}
      {field('provider 标签', input(form.provider, value => patch({ provider: value }), 'text', undefined, 'setup-provider'), errors.provider)}
      {field('端点', input(form.baseUrl, value => patch({ baseUrl: value }), 'text', undefined, 'setup-base-url'), errors.baseUrl)}
      {field('等级', (
        <select value={form.grade} onChange={event => patch({ grade: event.target.value as SetupForm['grade'] })}>
          {['low', 'medium', 'high', 'highest'].map(grade => <option key={grade} value={grade}>{grade}</option>)}
        </select>
      ))}
      {field('上下文窗口', input(String(form.contextWindow), value => patch({ contextWindow: Number(value) }), 'number', undefined, 'setup-context-window'), errors.contextWindow)}
      {field('最大输出', input(String(form.maxTokens), value => patch({ maxTokens: Number(value) }), 'number', undefined, 'setup-max-tokens'), errors.maxTokens)}

      <h3>凭据</h3>
      {field('凭据 id', input(form.credentialId, value => {
        const previous = defaultSecretRef(form.credentialId);
        patch({ credentialId: value, ...(form.secretRef === previous ? { secretRef: defaultSecretRef(value) } : {}) });
      }), errors.credentialId)}
      {field('凭据引用（环境变量名）', input(form.secretRef, value => patch({ secretRef: value }), 'text', undefined, 'setup-secret-ref'), errors.secretRef, '密钥只会以此名字出现在配置文件中')}
      {bridge && field('API 密钥', input(key, setKey, 'password', undefined, 'setup-key'))}
      {!bridge && <p style={{ color: '#555' }}>请设置环境变量 <code>{form.secretRef}</code> 后重启守护进程。</p>}

      <p style={{ marginTop: 16 }}>
        <button type="button" disabled={busy || revision === null} onClick={() => void submit()} data-testid="setup-save">
          {busy ? '保存中…' : bridge ? '保存并重启' : '保存配置'}
        </button>
        {revision !== null && <small style={{ color: '#666', marginLeft: 12 }}>已保存 revision {revision}</small>}
      </p>
      </>}
    </section>
  );
}

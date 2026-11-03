import {
PROVIDER_COMPATIBILITIES,
nextAccountDraft,
type ProviderDraft
} from './provider-form.ts';
import { ProviderLogin } from './ProviderLogin.tsx';
import { ProviderPicker } from './ProviderPicker.tsx';
import { useProviderWorkbenchState } from "./settings-provider-state.tsx";
import { Button,Card,Field,Pill } from './ui.tsx';

export function ProviderCredentialsView({ platforms, platformId, choosePlatform, busy, selected, platformsNote, isCustom, fieldError, mark, custom, setCustom, active, editAccount, draft, setKey, resolved, setKeyResolved, onCredentialStored, setPlatforms, bridge, keyGuidance, key, copyExportLine, limitIds, concurrency, setConcurrency, saveProvider, verification }: Pick<Extract<ReturnType<typeof useProviderWorkbenchState>, { fallback: null }>, "platforms" | "platformId" | "choosePlatform" | "busy" | "selected" | "platformsNote" | "isCustom" | "fieldError" | "mark" | "custom" | "setCustom" | "active" | "editAccount" | "draft" | "setKey" | "resolved" | "setKeyResolved" | "onCredentialStored" | "setPlatforms" | "bridge" | "keyGuidance" | "key" | "copyExportLine" | "limitIds" | "concurrency" | "setConcurrency" | "saveProvider" | "verification">) {
return <section id="settings-credentials" className="settings-section" data-testid="provider-setup">
        <Card title="① 配置厂商" icon="link" subtitle="已支持厂商只需填 API KEY 或订阅凭据；自定义厂商需填名称、Base URL 与兼容格式。保存后自动发起一次最小请求验证，失败会原样显示厂商错误。">
          <ProviderPicker choices={platforms} value={platformId} onChange={choosePlatform} testId="provider-platforms" testIdPrefix="provider-platform-" disabled={busy} />
          {selected?.docsUrl && <p className="provider-help"><a href={selected.docsUrl} target="_blank" rel="noreferrer">获取 {selected.label} API 凭据 ↗</a></p>}
          {platformsNote && <p className="muted" data-testid="provider-platforms-note">{platformsNote}</p>}
          {selected?.notes?.length ? <p className="muted">{selected.notes.join('；')}</p> : null}
          {!selected?.modelsListSupported && <p className="muted" data-testid="provider-no-models-list">目录提示该端点可能不支持 /models 列表；保存后仍会尝试请求并以厂商响应为准，失败时请手动添加模型 id。</p>}

          <div className="card-grid">
            {isCustom ? (
              <>
                <Field label="Base URL" error={fieldError('baseUrl')}><input className="input" data-testid="provider-baseUrl" data-invalid={mark('baseUrl')} value={custom.baseUrl} onChange={event => setCustom({ ...custom, baseUrl: event.target.value })} placeholder="https://gateway.example.com/v1" /></Field>
                <Field label="兼容格式" error={fieldError('api')}>
                  <select className="select" data-testid="provider-api" data-invalid={mark('api')} value={custom.api} onChange={event => setCustom({ ...custom, api: event.target.value as ProviderDraft['api'] })}>
                    {PROVIDER_COMPATIBILITIES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label="端点"><input className="input" value={active.baseUrl} readOnly data-testid="provider-baseUrl" /></Field>
                <Field label="兼容格式"><input className="input" value={PROVIDER_COMPATIBILITIES.find(item => item.id === active.api)?.label ?? active.api} readOnly data-testid="provider-api" /></Field>
              </>
            )}
            <Field label="名称" hint="用量页与模型列表显示这个名字；支持自定义" error={fieldError('label')}><input className="input" data-testid="provider-label" data-invalid={mark('label')} value={active.label} onChange={event => editAccount({ label: event.target.value })} placeholder={isCustom ? '例如 本地网关' : undefined} /></Field>
            <Field label="凭据 id" hint={isCustom ? undefined : '同一平台可配置多个账户：id 不同即不同账户'} data-testid="provider-credentialId-field"><input className="input" data-testid="provider-credentialId" data-invalid={mark('credentialId')} value={active.credentialId} onChange={event => editAccount({ credentialId: event.target.value })} /></Field>
            <div className="field-full">
              <Field label="环境变量（credentialRef）" hint="配置文件只保存这个名字" error={fieldError('credentialRef')}><input className="input" data-testid="provider-credentialRef" data-invalid={mark('credentialRef')} value={active.credentialRef} onChange={event => editAccount({ credentialRef: event.target.value })} /></Field>
            </div>
          </div>

          {isCustom ? null : (
            <div className="row" style={{ marginTop: 8 }}>
              <Button
                size="sm"
                icon="plus"
                data-testid="provider-add-account"
                disabled={busy}
                onClick={() => {
                  if (!selected) return;
                  const next = nextAccountDraft(selected, Object.keys(draft.credentials ?? {}));
                  editAccount({ credentialId: next.credentialId, credentialRef: next.credentialRef });
                  setKey('');
                }}
              >
                同一平台再加一个账户
              </Button>
              <span className="muted">每个账户有自己的密钥与额度；模型在下一步选择用哪个账户</span>
            </div>
          )}

          {selected?.oauthProvider && <ProviderLogin key={`${selected.oauthProvider}:${active.credentialRef}`} providerId={selected.oauthProvider} credentialRef={active.credentialRef} configured={resolved} onChange={configured => {
            setKeyResolved(current => ({ ...current, [active.credentialId]: configured }));
            onCredentialStored(active.credentialId, configured);
            setPlatforms(current => current.map(platform => platform.id === platformId ? { ...platform, credentialConfigured: configured } : platform));
          }} />}
          {bridge ? (
            <Field label={keyGuidance.title} hint="只写入系统钥匙串，不进入配置文件、接口响应或页面" error={fieldError('key')}>
              <input className="input" style={{ maxWidth: 'none' }} type="password" data-testid="provider-key" data-invalid={mark('key')} value={key} onChange={event => setKey(event.target.value)} placeholder="sk-…" />
            </Field>
          ) : (
            <div className="key-guidance" data-testid="provider-key-guidance">
              <p className="key-guidance-title" data-testid="provider-key-hint">{keyGuidance.title}</p>
              {keyGuidance.lines.map((line, index) => <p key={index} className="muted key-guidance-line">{line}</p>)}
              {fieldError('key') && <p className="field-error" data-testid="provider-key-error">{fieldError('key')}</p>}
              <div className="row key-guidance-export">
                <code className="mono" data-testid="provider-key-env">{keyGuidance.envVar}</code>
                <Button size="sm" icon="copy" data-testid="provider-key-copy" onClick={() => void copyExportLine(keyGuidance.exportLine)}>复制 export 行</Button>
              </div>
              <code className="mono key-export" data-testid="provider-key-export">{keyGuidance.exportLine}</code>
            </div>
          )}

          <div className="provider-concurrency" data-testid="provider-concurrency">
            <p className="field-hint">并发控制（保存后立即对新请求生效，不中断在途请求）：每个凭据上限与跨凭据共享组上限都在本厂商条目内编辑。</p>
            <div className="row">
              <Field label="本凭据并发上限"><input className="input" style={{ width: 120 }} type="number" data-testid={limitIds.credential} value={concurrency.credentialLimit} onChange={event => setConcurrency({ ...concurrency, credentialLimit: event.target.value })} placeholder="默认" /></Field>
              <Field label="共享组 id"><input className="input" style={{ width: 180 }} data-testid={limitIds.groupId} value={concurrency.sharedGroupId} onChange={event => setConcurrency({ ...concurrency, sharedGroupId: event.target.value })} placeholder="可选" /></Field>
              <Field label="共享组并发上限"><input className="input" style={{ width: 120 }} type="number" data-testid={limitIds.groupLimit} value={concurrency.sharedGroupLimit} onChange={event => setConcurrency({ ...concurrency, sharedGroupLimit: event.target.value })} placeholder="默认" /></Field>
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <Button variant="primary" icon="check" data-testid="provider-save" disabled={busy} onClick={() => void saveProvider()}>{busy ? '验证中…' : '保存并验证'}</Button>
            <Pill tone={resolved ? 'success' : 'warn'} testid="provider-credential-state">{resolved ? '凭据已解析' : '凭据缺失'}</Pill>
          </div>
          {verification && (
            <p data-testid="provider-verification" className={verification.ok ? 'muted' : 'field-error'}>
              {verification.ok ? '验证成功：厂商已返回最小请求响应。' : `验证失败：${verification.error}`}
            </p>
          )}
        </Card>
      </section>;
}

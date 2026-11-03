import { useState } from 'react';
import { providerPreset } from '../catalog/providers.ts';
import openai from './assets/providers/openai.svg';
import anthropic from './assets/providers/anthropic.svg';
import gemini from './assets/providers/gemini-color.svg';
import deepseek from './assets/providers/deepseek-color.svg';
import openrouter from './assets/providers/openrouter.svg';
import grok from './assets/providers/grok.svg';
import opencode from './assets/providers/opencode.svg';
import './providers.css';

const ICONS: Record<string, string> = { openai, chatgpt: openai, anthropic, gemini, deepseek, openrouter, grok, 'opencode-go': opencode };

export function ProviderIcon({ id }: { id: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = ICONS[id];
  return <span className="provider-brand" aria-hidden="true">
    {src && failed !== src
      ? <img src={src} alt="" width="24" height="24" onError={() => setFailed(src)} />
      : <span className="provider-brand-fallback">{id === 'custom' ? '+' : (providerPreset(id)?.label || id).slice(0, 1).toUpperCase()}</span>}
  </span>;
}

interface Choice {
  id: string;
  label: string;
  baseUrl: string;
  credentialKind?: 'api-key' | 'subscription';
  credentialConfigured?: boolean;
  oauthProvider?: 'openrouter' | 'xai';
}

export function ProviderPicker({ choices, value, onChange, testIdPrefix, testId, disabled = false }: {
  choices: readonly Choice[];
  value: string;
  onChange: (id: string) => void;
  testIdPrefix: string;
  testId: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const normalized = query.trim().toLocaleLowerCase();
  const matches = choices.filter(item => item.id !== 'custom'
    && (category === 'all' || (category === 'subscription') === (item.credentialKind === 'subscription'))
    && `${item.id} ${item.label} ${item.baseUrl}`.toLocaleLowerCase().includes(normalized));
  const custom = choices.find(item => item.id === 'custom');
  const selected = choices.find(item => item.id === value);
  return <div className="provider-picker" data-testid={testId}>
    <div className="provider-picker-tools">
      <input className="input" type="search" aria-label="搜索服务商" placeholder="搜索名称或 API 地址…" value={query} onChange={event => setQuery(event.target.value)} />
      <select className="select" aria-label="服务商类型" value={category} onChange={event => setCategory(event.target.value)}>
        <option value="all">全部类型</option><option value="api-key">API key</option><option value="subscription">订阅凭据</option>
      </select>
    </div>
    <div className="provider-choice-grid" role="group" aria-label="选择服务商">
      {matches.map(item => <button type="button" key={item.id} className="provider-choice" aria-pressed={value === item.id} data-testid={`${testIdPrefix}${item.id}`} disabled={disabled} onClick={() => onChange(item.id)}>
        <ProviderIcon id={item.id} />
        <span className="provider-choice-copy"><strong>{item.label}</strong><span>{item.oauthProvider ? '账号登录或密钥' : item.credentialKind === 'subscription' ? '订阅访问令牌' : 'API key'}</span></span>
        {item.credentialConfigured && <span className="provider-ready">已配置</span>}
        {value === item.id && <span className="provider-selected" aria-label="已选择">✓</span>}
      </button>)}
    </div>
    {matches.length === 0 && <p className="muted" role="status">没有匹配的服务商，可使用自定义兼容服务。</p>}
    {custom && <button type="button" className="provider-choice provider-custom-choice" aria-pressed={value === custom.id} data-testid={`${testIdPrefix}${custom.id}`} disabled={disabled} onClick={() => onChange(custom.id)}>
      <ProviderIcon id="custom" /><span className="provider-choice-copy"><strong>自定义服务商</strong><span>连接兼容 API 或本地模型服务</span></span>{value === custom.id && <span className="provider-selected" aria-label="已选择">✓</span>}
    </button>}
    {selected && <p className="provider-current muted" role="status">当前选择：{selected.label}</p>}
  </div>;
}

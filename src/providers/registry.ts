import type { ProviderName, ComparoConfig } from '../types.js';
import { ProviderAdapter } from './interface.js';
import { ClaudeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { CodexAdapter } from './codex.js';

const adapterCache = new Map<ProviderName, ProviderAdapter>();

export function getProvider(name: ProviderName, config: ComparoConfig): ProviderAdapter {
  const cached = adapterCache.get(name);
  if (cached) return cached;

  const providerConfig = config.providers[name];
  let adapter: ProviderAdapter;

  switch (name) {
    case 'claude':
      adapter = new ClaudeAdapter(providerConfig);
      break;
    case 'gemini':
      adapter = new GeminiAdapter(providerConfig);
      break;
    case 'codex':
      adapter = new CodexAdapter(providerConfig);
      break;
  }

  adapterCache.set(name, adapter);
  return adapter;
}

export function getProviders(names: ProviderName[], config: ComparoConfig): ProviderAdapter[] {
  return names.map(name => getProvider(name, config));
}

export function clearProviderCache(): void {
  adapterCache.clear();
}

import { loadConfig } from '../config/loader.js';
import { getProvider } from '../providers/registry.js';
import type { ProviderName } from '../types.js';

const ALL_PROVIDERS: ProviderName[] = ['claude', 'gemini', 'codex'];

export async function runDoctor(): Promise<void> {
  const config = await loadConfig();

  console.log('Comparo Doctor');
  console.log('==============\n');

  let allHealthy = true;

  for (const name of ALL_PROVIDERS) {
    const provider = getProvider(name, config);
    const diag = await provider.diagnose();

    const status = diag.installed ? '\u2705' : '\u274C';
    console.log(`${status} ${name}`);

    if (diag.installed) {
      if (diag.version) console.log(`  Version: ${diag.version}`);
      console.log(`  Authenticated: ${diag.authenticated ? 'yes' : 'no'}`);
      console.log(`  JSON output: ${diag.supportsJson ? 'yes' : 'no'}`);
    } else {
      console.log(`  Error: ${diag.error}`);
      allHealthy = false;
    }

    console.log();
  }

  if (allHealthy) {
    console.log('All providers healthy!');
  } else {
    console.log('Some providers are not available. Install missing CLIs to use them.');
  }
}

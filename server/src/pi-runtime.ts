/** Resolve child CLI from the SDK actually hosted by Web, not shell PATH. @author coolonion */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configureSubagentCli(env: NodeJS.ProcessEnv = process.env,
  entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))): string | undefined {
  // An explicit executable remains an intentional operator override.
  if (env.PI_SUBAGENT_PI_BINARY?.trim()) return undefined;
  if (env.PI_SUBAGENT_PI_SCRIPT?.trim()) {
    const script = env.PI_SUBAGENT_PI_SCRIPT.trim();
    if (!isAbsolute(script) || !existsSync(script)) throw new Error('Invalid PI_SUBAGENT_PI_SCRIPT: expected an existing absolute CLI path');
    return script;
  }
  for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
    const manifest = resolve(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.name !== '@earendil-works/pi-coding-agent') continue;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
    const script = typeof bin === 'string' ? resolve(dir, bin) : undefined;
    if (!script || !existsSync(script)) throw new Error('Hosted Pi SDK has no runnable CLI entry');
    env.PI_SUBAGENT_PI_SCRIPT = script;
    console.info(`[mewpii] subagent_cli_resolved source=hosted_sdk entry=${script}`);
    return script;
  }
  throw new Error('Cannot resolve hosted Pi SDK for subagent execution');
}

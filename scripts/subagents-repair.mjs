/** Version-pinned pi-subagents repair. --check is read-only; --apply is deployment only. @author coolonion */
import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = '// mewpii-subagents-lifecycle-v1';
export const targetVersion = '0.56.0';
const bridgePath = 'src/extension/mewpii-runtime-bridge.ts';
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unsupported pi-subagents source near ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
export function repairSpawn(source) {
  return once(source, 'const piCliPath = resolvePiCliScript(deps);', `// Web hosts are not the Pi CLI and may have no pi executable on PATH.
\tconst hostScript = env.PI_SUBAGENT_PI_SCRIPT?.trim();
\tif (hostScript) {
\t\tif (!path.isAbsolute(hostScript) || !isRunnableNodeScript(hostScript, deps.existsSync ?? fs.existsSync))
\t\t\tthrow new Error("Invalid PI_SUBAGENT_PI_SCRIPT: expected an existing absolute CLI script");
\t\treturn { command: execPath, args: [hostScript, ...args] };
\t}
\tconst piCliPath = resolvePiCliScript(deps);`);
}
export function repairExecution(source) {
  let s = once(source, 'if (!detachedReason) originController.abort(originSignal?.reason);',
    'if (!detachedReason || options.awaitDetachedCompletion) originController.abort(originSignal?.reason);');
  s = once(s, 'if (!detachedReason || terminalCallbackInvoked) return;',
    'if (!detachedReason || terminalCallbackInvoked || options.awaitDetachedCompletion) return;');
  s = once(s, 'detachedReason = detachedReceipt.detachedReason ?? "user request";',
    `detachedReason = detachedReceipt.detachedReason ?? "user request";
\t\t\tif (options.awaitDetachedCompletion) {
\t\t\t\ttry { options.onWorkflowDetach?.(structuredClone(callerReceipt)); }
\t\t\t\tcatch { console.error(\x60[mewpii] subagent_detach_snapshot_failed run_id=\x24{options.runId}\x60); }
\t\t\t\tconsole.error(\x60[mewpii] subagent_detached run_id=\x24{options.runId} continuation=retained\x60);
\t\t\t}`);
  s = once(s, 'return Promise.race([authoritativeCompletion, receipt]);', `// A live background workflow owns its JS continuation. Keep its await alive;
\t// supervisor coordination still detaches the child from the interactive turn.
\tif (options.awaitDetachedCompletion) {
\t\tconst result = await authoritativeCompletion;
\t\tresult.detached = undefined;
\t\treturn result;
\t}
\treturn Promise.race([authoritativeCompletion, receipt]);`);
  return s;
}
export function repairExecutor(source) {
  return once(source, 'allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,',
    `// Only retain an independently scheduled workflow, never block an interactive
\t\t\t// foreground parent that must answer the supervisor request itself.
\t\t\tawaitDetachedCompletion: Boolean(params.workflowParentRunId && deps.state.workflowControllers?.has(params.workflowParentRunId)),
\t\t\tonWorkflowDetach: (receipt) => rememberForegroundRun(deps.state, { runId, mode: "single", cwd: singleCwd, sessionId: data.parentSessionId, results: [receipt], extensionBindings: params.extensionBindings }),
\t\t\tallowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,`);
}
export function repairTypes(source) {
  return once(source, 'export interface RunSyncOptions {', 'export interface RunSyncOptions {\n\t/** Keep the live background workflow continuation across child coordination. */\n\tawaitDetachedCompletion?: boolean;\n\t/** Publish provisional history for supervisor and wait subscriptions while the workflow keeps waiting. */\n\tonWorkflowDetach?: (receipt: SingleResult) => void;');
}
export function repairExtension(source) {
  let s = 'import { registerRuntimeBridge } from "./mewpii-runtime-bridge.ts";\n' + source;
  s = once(s, 'const eventUnsubscribes = [', 'const eventUnsubscribes = [\n\t\tregisterRuntimeBridge(pi.events, state),');
  return s;
}
const repairs = {
  'src/runs/shared/pi-spawn.ts': repairSpawn,
  'src/runs/foreground/execution.ts': repairExecution,
  'src/runs/foreground/subagent-executor.ts': repairExecutor,
  'src/shared/types.ts': repairTypes,
  'src/extension/index.ts': repairExtension,
};

export async function planRepair(root) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'pi-subagents' || pkg.version !== targetVersion) throw new Error(`Unsupported pi-subagents version: ${pkg.version}`);
  const plan = [];
  for (const [file, repair] of Object.entries(repairs)) {
    const original = await readFile(join(root, file), 'utf8');
    if (original.startsWith(marker)) {
      // Verify existing patch against its original backup; do not trust a marker alone.
      const backup = await readFile(join(root, `${file}.mewpii-v1.bak`), 'utf8');
      if (original !== `${marker}\n${repair(backup)}`) throw new Error(`Patched file drift: ${file}`);
      continue;
    }
    plan.push({ file, original, content: `${marker}\n${repair(original)}` });
  }
  const content = await readFile(new URL('./compat/subagent-runtime-bridge.ts', import.meta.url), 'utf8');
  let current;
  try { current = await readFile(join(root, bridgePath), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== undefined && current !== content) throw new Error('Native runtime bridge drift');
  if (current === undefined) plan.push({ file: bridgePath, content });
  return plan;
}

export async function applyRepair(root) {
  const plan = await planRepair(root); // Validate every source before touching any file.
  for (const item of plan) {
    if (item.original === undefined) continue;
    const backup = join(root, `${item.file}.mewpii-v1.bak`);
    try { await stat(backup); throw new Error(`Existing backup blocks partial repair: ${item.file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const written = [];
  try {
    // The new module is installed before imports can reference it.
    for (const item of [...plan].sort((a, b) => Number(a.original !== undefined) - Number(b.original !== undefined))) {
      const file = join(root, item.file);
      if (item.original !== undefined) await copyFile(file, `${file}.mewpii-v1.bak`);
      written.push(item);
      await writeFile(file, item.content);
    }
  } catch (error) {
    for (const item of written.reverse()) if (item.original !== undefined) await writeFile(join(root, item.file), item.original);
    throw error;
  }
  return plan.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root] = process.argv.slice(2);
  if (!['--check', '--apply'].includes(mode) || !root) throw new Error('Usage: node scripts/subagents-repair.mjs --check|--apply <pi-subagents package directory>');
  const plan = await planRepair(resolve(root));
  if (mode === '--apply') await applyRepair(resolve(root));
  console.log(JSON.stringify({ version: targetVersion, mode, files: plan.map(p => p.file), alreadyPatched: plan.length === 0 }));
}

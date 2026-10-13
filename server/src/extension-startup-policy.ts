/** Hosted sessions share a process; avoid full eager Lens scans on every attach. @author coolonion */
export function configureExtensionStartup(env: NodeJS.ProcessEnv = process.env): void {
  // Respect explicit operator choices, including full and minimal.
  if (env.PI_LENS_STARTUP_MODE !== undefined) return;
  env.PI_LENS_STARTUP_MODE = 'quick';
  console.info('[extensions] startup_policy plugin=pi-lens mode=quick source=host_default');
}

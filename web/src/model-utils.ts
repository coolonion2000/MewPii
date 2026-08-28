/** Pure model/auth response decisions shared by the UI and runtime tests. @author coolonion */
export interface ProviderLogoutBody {
  ok?: boolean;
  error?: string;
}

export interface ProviderLogoutOutcome {
  ok: boolean;
  notice: string;
}

export function evaluateProviderLogout(
  provider: string,
  logoutLabel: string,
  responseOk: boolean,
  status: number,
  body: ProviderLogoutBody,
): ProviderLogoutOutcome {
  if (!responseOk || !body.ok) {
    return {
      ok: false,
      notice: body.error ?? `logout failed: ${status}`,
    };
  }
  return { ok: true, notice: `${provider}: ${logoutLabel} ✓` };
}

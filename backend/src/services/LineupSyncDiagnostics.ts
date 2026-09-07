export function lineupSyncDiagnostics(payload: any) {
  const warnings = Array.isArray(payload?.providerWarnings) ? payload.providerWarnings.map(String) : [];
  return {
    checked: Number(payload?.checked ?? 0),
    saved: Number(payload?.saved ?? 0),
    predictedSaved: Number(payload?.predictedSaved ?? 0),
    alreadyConfirmed: Number(payload?.alreadyConfirmed ?? 0),
    providerWarnings: warnings.length,
    providerWarningMessages: warnings.slice(0, 10),
    providerStatus: payload?.enabled === false ? 'disabled' : warnings.length ? 'degraded'
      : Number(payload?.checked ?? 0) === 0 ? 'not_checked' : 'ok',
  };
}

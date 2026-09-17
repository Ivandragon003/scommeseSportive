/** Bootstrap retries are short: they cannot resolve plan blocks or rate limits. */
export function shouldRetryBootstrapSync(error: unknown, httpStatus?: number): boolean {
  const detail = error as { code?: string; message?: string; cause?: { code?: string } } | null;
  if (detail?.code === 'BLOCKED' || detail?.cause?.code === 'BLOCKED') return false;
  const message = String(detail?.message ?? error ?? '');
  if (/SQL (?:read|write) operations are forbidden|reads are blocked|upgrade your plan|quota.*(?:exceeded|exhausted)/i.test(message)) {
    return false;
  }
  if (httpStatus === 429) return false;
  if (httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) return false;
  return true;
}

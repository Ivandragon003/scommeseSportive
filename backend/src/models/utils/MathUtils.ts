export function logGamma(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return Infinity;
  if (x < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  }

  const g = 7;
  const coeffs = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  const xr = x - 1;
  let ag = coeffs[0];
  for (let i = 1; i < g + 2; i++) ag += coeffs[i] / (xr + i);
  const t = xr + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (xr + 0.5) * Math.log(t) - t + Math.log(ag);
}

function logFactorial(n: number): number {
  if (!Number.isFinite(n) || n < 0) return Infinity;
  const nn = Math.floor(n);
  if (nn <= 1) return 0;
  return logGamma(nn + 1);
}

export function poissonPMF(k: number, lambda: number): number {
  if (!Number.isFinite(k) || k < 0) return 0;
  const kk = Math.floor(k);
  if (!Number.isFinite(lambda) || lambda <= 0) return kk === 0 ? 1 : 0;

  const logP = -lambda + kk * Math.log(lambda) - logFactorial(kk);
  const value = Math.exp(logP);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function negBinPMF(k: number, mu: number, r: number): number {
  if (!Number.isFinite(k) || k < 0) return 0;
  const kk = Math.floor(k);
  if (!Number.isFinite(mu) || mu <= 0) return kk === 0 ? 1 : 0;
  if (!Number.isFinite(r) || r <= 0 || r > 500) return poissonPMF(kk, mu);

  const p = r / (r + mu);
  const logP =
    logGamma(kk + r) -
    logFactorial(kk) -
    logGamma(r) +
    r * Math.log(p) +
    kk * Math.log(1 - p);

  const value = Math.exp(logP);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function negBinCDF(kMax: number, mu: number, r: number): number {
  if (!Number.isFinite(kMax) || kMax < 0) return 0;

  let cdf = 0;
  const cap = Math.max(0, Math.floor(kMax));
  const adaptiveCut = Math.ceil(mu + 10 * Math.sqrt(Math.max(0, mu + (mu * mu) / Math.max(r, 0.1))));
  const limit = Math.min(cap, adaptiveCut + 20);

  for (let k = 0; k <= limit; k++) {
    cdf += negBinPMF(k, mu, r);
    if (cdf >= 1 - 1e-10) break;
  }

  return Math.max(0, Math.min(1, cdf));
}

export function negBinOver(threshold: number, mu: number, r: number): number {
  return Math.max(0, Math.min(1, 1 - negBinCDF(Math.floor(threshold), mu, r)));
}

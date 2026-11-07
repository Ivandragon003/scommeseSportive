# Current challenger

`challenger.json` is the sole packaged C artifact. Its model, baseline,
configuration and content hashes are pinned by
[`CurrentChallengerRelease.ts`](../src/research/CurrentChallengerRelease.ts).
The runtime still requires explicit registry registration and a compatible
deployment; packaging does not write to a database or bypass adoption guards.

Training and historical diagnostic limits are documented in
[MODEL-C.md](../../docs/models/MODEL-C.md). Old model weights were removed
at the user's request; historical observations and prediction bundles remain.
No old-model archive is created by this package.

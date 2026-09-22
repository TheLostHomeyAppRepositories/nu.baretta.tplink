`tplink-smarthome-api-5.0.4.tgz` is the compiled package for the
[v5.0.4 fork release](https://github.com/shaarkys/tplink-smarthome-api/releases/tag/v5.0.4).
It rounds dimmer brightness to whole percentages, avoiding HS220 floating-point error -1008.
It preserves the new_klap and ANS discovery flags for diagnostics. Authentication behavior is unchanged.
It fixes both SMART and legacy IOT dimmer brightness zero by switching off without
overwriting the saved brightness, and clarifies exhausted KLAP v2/v1 checks.
It also retains the previous authenticated transport,
SMART parent identity, and separate IOT/SMART command support.

Rebuild from the sibling repository with:

```powershell
npm run build
npm pack --ignore-scripts --pack-destination ../nu.baretta.tplink/vendor
```

Then install the archive from this repository:

```powershell
npm install ./vendor/tplink-smarthome-api-5.0.4.tgz --ignore-scripts
```

The archive is also attached to the GitHub release. Homey uses this exact version
through `package.json` and the integrity hash in `package-lock.json`, without
requiring TypeScript compilation during Homey installation. API production
dependencies and the Node.js requirement (>=16) are unchanged.

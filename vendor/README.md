`tplink-smarthome-api-5.0.1.tgz` is the compiled package for the
[v5.0.1 fork release](https://github.com/shaarkys/tplink-smarthome-api/releases/tag/v5.0.1).
It fixes SMART dimmer brightness zero by switching off without overwriting the
saved brightness. It also retains the previous authenticated transport,
SMART parent identity, and separate IOT/SMART command support.

Rebuild from the sibling repository with:

```powershell
npm run build
npm pack --ignore-scripts --pack-destination ../nu.baretta.tplink/vendor
```

Then install the archive from this repository:

```powershell
npm install ./vendor/tplink-smarthome-api-5.0.1.tgz --ignore-scripts
```

The archive is also attached to the GitHub release. Homey uses this exact version
through `package.json` and the integrity hash in `package-lock.json`, without
requiring TypeScript compilation during Homey installation. API production
dependencies and the Node.js requirement (>=16) are unchanged.

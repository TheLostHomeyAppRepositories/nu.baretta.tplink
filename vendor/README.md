The local `tplink-smarthome-api-5.0.0.tgz` contains the compiled sibling
`../tplink-smarthome-api` checkout with the SMART parent identity correction
and separate IOT/SMART command selection over authenticated transports.
Its baseline source tree matches the previously pinned revision
`450e1c3d91b7689c8f01810c31575eb73c5948f0`.

Rebuild from the sibling repository with:

```powershell
npm run build
npm pack --ignore-scripts --pack-destination ../nu.baretta.tplink/vendor
```

Then install the archive from this repository:

```powershell
npm install ./vendor/tplink-smarthome-api-5.0.0.tgz --ignore-scripts
```

This local dependency makes the fix available to Homey builds without publishing
the library or referencing an unpublished Git commit. The API version and its
production dependencies are unchanged. Replace it with a reviewed published Git
revision when explicitly releasing the library.

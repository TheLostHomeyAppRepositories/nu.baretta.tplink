# HS220 after a firmware upgrade

## KLAP authentication

[python-kasa PR #1731](https://github.com/python-kasa/python-kasa/pull/1731)
selects KLAP v2 for IOT devices advertising login version 2 or later. The IOT
command format stays unchanged. Our API already checks the same v2 challenge
first, followed by v1, using supplied credentials, known setup defaults, and
blank credentials. These are local comparisons against one handshake response.

The recipes match [python-kasa's transport implementation](https://github.com/python-kasa/python-kasa/blob/master/kasa/transports/klaptransport.py):

- v2 credential hash: SHA256(SHA1(username) + SHA1(password)); first challenge:
  SHA256(local seed + remote seed + credential hash).
- v1 credential hash: MD5(MD5(username) + MD5(password)); first challenge:
  SHA256(local seed + credential hash).

The API regression suite now explicitly exercises HS220 IOT/KLAP discovery with
`lv: 2`, successful v2 authentication, v1 fallback despite that advertisement,
and encrypted IOT status queries. The test server uses dummy credentials and
loopback networking; it does not prove authentication on a customer's device.

If the error says `KLAP v2 and v1 credential checks exhausted`, neither version
matched any available credential candidate. Forcing v2 again cannot resolve
that particular failure. The PR discussion includes reports of device-side
credential/provisioning state changing after re-pairing, but this is not a
confirmed diagnosis for every HS220. Kasa app success alone does not identify
which authentication path succeeded.

The reported reset of HS220 at `.76` restored Homey communication over **TCP**.
That is useful recovery evidence, but it is not confirmation of KLAP recovery.
To investigate a still-failing unit, capture its hardware/firmware versions,
discovery encryption metadata (including `lv` and `ANS`, when present), and a
fresh authentication result before resetting it. Do not share passwords,
credential hashes, handshake captures, or session cookies in public logs.

## Brightness zero

SMART and legacy IOT firmware can both reject a literal brightness of zero.
API 5.0.2 sends the existing dimmer switch-off command for IOT and retains the
SMART power-off behavior from 5.0.1. Saved brightness is preserved.

Homey displays zero while the HS220 relay is off. Raising the slider above zero
sets brightness and powers the relay on when needed, for both command protocols.

After installing the updated integration, test each affected transport:

1. Set 70%, then 0%; the light should turn off without `-3` or `-1008`.
2. Wait two polling cycles; Homey should still show off/0%.
3. Set 25%; the light should turn on at 25%.
4. Turn it off/on normally; the remembered brightness should be retained.

Physical validation of the 5.0.2 correction and authentication of an affected,
unreset HS220 remain pending.

## Collecting diagnostics through Homey

Open the app settings and press **Collect HS220 diagnostics**. After about six
seconds, copy the report from the text box or share the app log. No access to the
switches from a separate computer is needed. The scan targets only IPv4 addresses
of paired HS220 devices and does not authenticate, change settings, or send controls.
Concurrent button requests share a single scan; sockets and listeners are stopped
when the scan finishes or fails.

The report contains the API/app versions, credential source and whether it matches
the global account (booleans only), cached status, time of the last successful poll,
and discovery model/type, hardware/firmware, encryption, HTTP port, login version,
`new_klap`, and `ANS`. API 5.0.3 preserves the last two flags when advertised.
It excludes usernames, passwords, owner hashes, MAC/device IDs, cookies, and
handshake material. Local IP addresses are included to correlate log entries.
Null fields mean unavailable metadata, not a negative authentication result.
Cached status is not a fresh read; discovery can omit firmware/hardware details.
The flags are diagnostic evidence, not proof of a specific authentication cause.

Also capture the normal log while setting a responding HS220 to **70%, 0%, then
25%**, waiting at least two polling intervals after each command. Each brightness
request records its protocol, previous relay/brightness, acknowledgment or failing
stage. Acknowledgment is not physical verification. Changed polling state shows
the device's remembered brightness separately from the output displayed in Homey.
Repeated unchanged polls do not add new diagnostic lines. Existing recovery logs
now include safe discovery metadata when it changes.

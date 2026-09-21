'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { collect, metadata } = require('../lib/hs220-diagnostics');
const { fixture } = require('./helpers/tplink-device-fixture');

const credentials = { username: 'private@example.com', password: 'private-password' };
function entry(host, settings = {}) {
  return { driverId: 'hs220', device: {
    activeTransport: 'klap',
    getSettings: () => ({ settingIPAddress: host, credentialSource: 'global', ...settings }),
    getData: () => ({ id: 'private-id' }), getStoreValue: () => undefined,
    plug: { sysInfo: { model: 'HS220(US)', hw_ver: '3.26', sw_ver: '1.1.4',
      relay_state: 0, brightness: 100, owner: 'private-owner', mac: 'private-mac' } },
  } };
}
function scan(entries = [entry('192.0.2.74'), entry('192.0.2.112')], behavior) {
  const client = new EventEmitter();
  let stopped = 0;
  let expire;
  let cleared = 0;
  client.stopDiscovery = () => { stopped++; };
  client.startDiscovery = options => { client.options = options; if (behavior) behavior(client); };
  const result = collect(entries, credentials, { createClient: () => client,
    setTimer: callback => { expire = callback; return 1; },
    clearTimer: timer => { assert.equal(timer, 1); cleared++; },
  });
  return { client, result, expire: () => expire(), checkClean() {
    assert.equal(stopped, 1); assert.equal(cleared, 1);
    assert.equal(client.eventNames().length, 0);
  } };
}

test('Homey report targets only paired HS220s and exposes allowlisted fields without authenticating', async () => {
  const s = scan([entry('192.0.2.74'), entry('192.0.2.112'), { driverId: 'hs210' }]);
  assert.equal(s.client.options.broadcast, '192.0.2.74');
  assert.deepEqual(s.client.options.devices, [{ host: '192.0.2.112' }]);
  const sysInfo = { model: 'HS220(US)', type: 'IOT.SMARTPLUGSWITCH',
    owner: 'private-owner', deviceId: 'private-id', password: 'private-password',
    mgt_encrypt_schm: { encrypt_type: 'KLAP', lv: 2, http_port: 80, new_klap: 1, ANS: true, token: 'private-token' } };
  const found = { host: '192.0.2.74', model: 'HS220(US)', sysInfo,
    getSysInfo() { assert.fail('diagnostic discovery must not authenticate'); } };
  s.client.emit('plug-new', found);
  s.client.emit('plug-online', found);
  s.client.emit('plug-new', { ...found, host: '192.0.2.200' });
  s.expire();
  const report = await s.result;
  assert.equal(report.devices.length, 2);
  assert.equal(report.devices[0].discovery.ANS, true);
  assert.equal(report.devices[0].discovery.new_klap, 1);
  assert.equal(report.devices[1].discovery, null);
  assert.equal(report.devices[0].cachedStatus.brightness, 100);
  assert.equal(report.devices[0].cachedStatus.relay, 0);
  assert.equal(report.devices[0].account, 'global');
  assert.equal(report.devices[0].matchesGlobalAccount, true);
  assert.equal(JSON.stringify(report).includes('private-'), false);
  assert.equal(JSON.stringify(report).includes(credentials.username), false);
  s.checkClean();
});

for (const mode of ['no-response', 'socket-error', 'start-throws', 'stop-throws']) {
  test(`diagnostic scan settles and cleans up: ${mode}`, async () => {
    const s = scan(undefined, client => {
      if (mode === 'socket-error') client.emit('error', new Error('private-payload'));
      if (mode === 'start-throws') throw new Error('private-payload');
    });
    if (mode === 'stop-throws') {
      const stop = s.client.stopDiscovery;
      s.client.stopDiscovery = () => { stop(); throw new Error('private-payload'); };
    }
    s.expire();
    const report = await s.result;
    assert.equal(report.scan, mode === 'no-response' ? 'finished' : 'discovery-error');
    assert.equal(JSON.stringify(report).includes('private-payload'), false);
    s.checkClean();
  });
}

test('empty or invalid targets never open a socket; account comparisons do not reveal credentials', async () => {
  const report = await collect([entry('not-an-ip', { credentialSource: 'override',
    deviceUsername: 'other@example.com', devicePassword: 'other-secret' })], credentials,
  { createClient() { assert.fail('no socket'); } });
  assert.equal(report.scan, 'no-targets');
  assert.equal(report.devices[0].host, null);
  assert.equal(report.devices[0].account, 'device');
  assert.equal(report.devices[0].matchesGlobalAccount, false);
  assert.equal(JSON.stringify(report).includes('other-secret'), false);
  assert.equal(metadata({ mgt_encrypt_schm: { ANS: { secret: true }, new_klap: 'secret' } }).ANS, null);
});

test('HS220 polling logs saved brightness separately from output and only on change', async () => {
  const f = fixture('hs220');
  f.sysInfo = { relay_state: 0, brightness: 100 };
  await f.device.onInit();
  await f.device.getStatus();
  await f.device.getStatus();
  assert.equal(f.logs.filter(line => line.includes('HS220 polled brightness:')).length, 1);
  assert.ok(f.logs.some(line => line.includes('"relay":0,"brightness":100,"output":0')));
  assert.ok(f.device.hs220LastSuccessfulPoll);
  f.sysInfo = { relay_state: 1, brightness: 25 };
  await f.device.getStatus();
  assert.equal(f.logs.filter(line => line.includes('HS220 polled brightness:')).length, 2);
  f.device.onDeleted();
});

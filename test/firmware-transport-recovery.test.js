'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./helpers/tplink-device-fixture');

const refused = Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:9999'),
  { code: 'ECONNREFUSED', port: 9999 });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function candidate(id, overrides = {}) {
  return { host: '192.0.2.10', deviceId: 'discovery-hash', model: id.toUpperCase() + '(US)',
    defaultSendOptions: { transport: 'klap' },
    getSysInfo: async () => ({ deviceId: 'plug-1', model: id.toUpperCase() + '(US)', type: 'IOT.SMARTPLUGSWITCH' }),
    ...overrides };
}
for (const id of ['hs210', 'hs220']) {
  test(`${id}: authentication diagnostics identify the source without exposing credentials`, async () => {
    const f = fixture(id);
    f.globalCredentials = { username: 'private-owner@example.com', password: 'private-password' };
    f.device.settings.dynamicIp = false;
    await f.device.onInit();
    f.error = refused;
    await f.poll(3);
    const plug = candidate(id, {
      sysInfo: { mgt_encrypt_schm: { lv: 2, secret: 'do-not-log' }, owner: 'do-not-log' },
      getSysInfo: async () => { throw new Error('authentication failed (challenge mismatch)'); },
    });
    f.clients.at(-1).emit('plug-new', plug);
    await flush();
    assert.ok(f.logs.some(line => line.includes('Transport candidate: transport=klap, login version=2, account=global')));
    assert.ok(f.logs.some(line => line.includes('challenge mismatch')));
    f.expireScan();
    f.now += 60000;
    await f.poll();
    f.clients.at(-1).emit('plug-new', plug);
    await flush();
    assert.equal(f.logs.filter(line => line.includes('Transport candidate:')).length, 1);
    for (const secret of ['private-owner@example.com', 'private-password', 'do-not-log']) {
      assert.equal(f.logs.join('\n').includes(secret), false);
    }
    assert.equal(f.device.activeTransport, 'tcp');
    assert.equal(f.device.store.tplinkConnection, undefined);
  });

  test(`${id}: refused legacy transport recovers at a fixed IP and persists across restart`, async () => {
    const f = fixture(id);
    f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
    f.device.settings.dynamicIp = false;
    f.device.getData = () => ({ id: 'existing-homey-id', transport: 'tcp' });
    await f.device.onInit();
    const oldClient = f.device.client;
    f.error = refused;
    await f.poll(3);
    const scan = f.clients.at(-1);
    assert.notEqual(scan, oldClient);
    assert.equal(scan.discoveryOptions.broadcast, '192.0.2.10');
    assert.deepEqual(JSON.parse(JSON.stringify(scan.discoveryOptions.devices)), [{ host: '192.0.2.10' }]);
    assert.deepEqual(scan.options.credentials, f.globalCredentials);
    scan.emit('plug-new', candidate(id, { host: '192.0.2.99' }));
    await flush();
    assert.equal(f.device.client, oldClient);
    scan.emit('plug-new', candidate(id));
    await flush();
    assert.equal(f.device.activeTransport, 'klap');
    assert.equal(f.device.client.options.defaultSendOptions.protocol, 'iot');
    assert.equal(f.device.store.tplinkConnection.host, '192.0.2.10');
    assert.equal(f.device.available, false, 'Discovery must not prematurely mark it available');
    f.error = null;
    await f.poll();
    assert.equal(f.device.available, true);
    await f.device.onInit();
    assert.equal(f.device.activeTransport, 'klap');
    assert.equal(f.device.client.options.defaultSendOptions.protocol, 'iot');
    assert.equal(f.device.getData().id, 'existing-homey-id');
  });

  test(`${id}: identity mismatch is rejected and a host is authenticated once per recovery scan`, async () => {
    const f = fixture(id);
    f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
    f.device.settings.dynamicIp = false;
    await f.device.onInit();
    f.error = refused;
    await f.poll(3);
    let calls = 0;
    const plug = candidate(id, { getSysInfo: async () => { calls++; return { deviceId: 'different-device' }; } });
    const scan = f.clients.at(-1);
    scan.emit('plug-new', plug);
    await flush();
    scan.emit('plug-online', plug);
    await flush();
    assert.equal(calls, 1);
    assert.equal(f.device.store.tplinkConnection, undefined);
    assert.equal(f.device.activeTransport, 'tcp');
  });

  test(`${id}: missing credentials and failed persistence retain the old connection`, async () => {
    const f = fixture(id);
    f.device.settings.dynamicIp = false;
    await f.device.onInit();
    f.error = refused;
    await f.poll(3);
    const oldClient = f.device.client;
    f.clients.at(-1).emit('plug-new', candidate(id, { getSysInfo() { assert.fail('No account means no authentication attempt'); } }));
    await flush();
    assert.equal(f.device.client, oldClient);
    assert.ok(f.logs.some(line => line.includes('save the TP-Link owner account')));
    f.expireScan();
    f.now += 60000;
    f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
    f.storeError = new Error('Store failed');
    await f.poll();
    f.clients.at(-1).emit('plug-new', candidate(id));
    await flush();
    assert.equal(f.device.client, oldClient);
    assert.equal(f.device.activeTransport, 'tcp');
    assert.equal(f.device.store.tplinkConnection, undefined);
    assert.ok(f.logs.some(line => line.includes('Store failed')));
  });

  test(`${id}: timeout at a static IP does not trigger transport switching; deletion cancels pending authentication`, async () => {
    const f = fixture(id);
    f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
    f.device.settings.dynamicIp = false;
    await f.device.onInit();
    f.error = new Error('TCP Timeout after 10000ms');
    const before = f.clients.length;
    await f.poll(3);
    assert.equal(f.clients.length, before);
    f.error = refused;
    await f.poll();
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    f.clients.at(-1).emit('plug-new', candidate(id, { getSysInfo: () => pending }));
    f.device.onDeleted();
    resolve({ deviceId: 'plug-1', type: 'IOT.SMARTPLUGSWITCH', model: id.toUpperCase() });
    await flush();
    assert.equal(f.device.store.tplinkConnection, undefined);
    assert.equal(f.timers.size, 0);
  });

  test(`${id}: settings changes wait for a pending profile write and prevent a stale client replacement`, async () => {
    const f = fixture(id);
    f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
    f.device.settings.dynamicIp = false;
    await f.device.onInit();
    f.error = refused;
    await f.poll(3);
    const oldClient = f.device.client;
    let resolve;
    f.storeGate = new Promise(r => { resolve = r; });
    f.clients.at(-1).emit('plug-new', candidate(id));
    await flush();
    let finished = false;
    const change = f.device._ipRecovery.settingsChanged(['settingIPAddress']).then(() => { finished = true; });
    await flush();
    assert.equal(finished, false);
    resolve();
    await change;
    assert.equal(f.device.client, oldClient);
    f.device.settings.settingIPAddress = '192.0.2.11';
    await f.device.onInit();
    assert.equal(f.device.activeTransport, 'tcp', 'A cached profile is bound to its validated IP');
  });
}

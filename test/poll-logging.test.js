'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, flush } = require('./helpers/tplink-device-fixture');

for (const id of ['hs220', 'es20m', 'ks230']) {
  test(`${id}: logs brightness only on first observation and changes`, async () => {
    const f = fixture(id);
    await f.poll(3);
    assert.equal(f.logs.filter(line => line.startsWith('State - brightness level:')).length, 1);
    assert.equal(f.logs.some(line => line.startsWith('getStatus')), false);
    f.sysInfo = { brightness: 35 };
    await f.poll(3);
    assert.equal(f.logs.filter(line => line.startsWith('State - brightness level:')).length, 2);
    assert.equal(f.clients[0].options.logLevel, 'silent');
  });
}

test('polling errors are logged on changes and after recovery without skipping polling', async () => {
  const f = fixture('hs220');
  f.device.settings.dynamicIp = false;
  f.error = new Error('connect ECONNREFUSED 192.0.2.10:9999');
  await f.poll(5);
  assert.equal(f.logs.filter(line => line.startsWith('Status polling failed:')).length, 1);
  assert.equal(f.requests.length, 5);
  f.error = new Error('TCP Timeout after 10000ms');
  await f.poll(3);
  assert.equal(f.logs.filter(line => line.startsWith('Status polling failed:')).length, 2);
  f.error = null;
  await f.poll(3);
  assert.equal(f.logs.filter(line => line === 'Device communication restored').length, 1);
  f.error = new Error('TCP Timeout after 10000ms');
  await f.poll(2);
  assert.equal(f.logs.filter(line => line.startsWith('Status polling failed:')).length, 3);
});

for (const id of ['ks240', 'ks225', 's500d', 'ep10']) {
  test(`${id}: rediscovery preserves existing stored IDs while authenticating the canonical parent`, async () => {
    for (const storedId of ['discovery-hash', 'canonical-parent']) {
      const f = fixture(id);
      f.device.settings.deviceId = storedId;
      f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
      f.error = new Error('connect EHOSTUNREACH 192.0.2.10:80');
      await f.poll(3);
      const scan = f.clients.at(-1);
      let authenticated = 0;
      const candidate = {
        deviceId: 'discovery-hash', host: '192.0.2.20', model: id.toUpperCase(),
        defaultSendOptions: { transport: 'klap' },
        async getSysInfo() {
          authenticated++;
          this.deviceId = 'canonical-parent';
          return { deviceId: this.deviceId, model: this.model };
        },
      };
      scan.emit('plug-new', candidate);
      await flush();
      assert.equal(authenticated, 1);
      assert.equal(f.device.settings.settingIPAddress, '192.0.2.20');
      assert.equal(f.device.settings.deviceId, storedId);
      assert.equal(scan.stops, 1);
    }
  });
}

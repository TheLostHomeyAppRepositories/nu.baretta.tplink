'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, flush } = require('./helpers/tplink-device-fixture');

const STAGGERED = ['ep10', 'ep25', 'es20m', 'hs100', 'hs103', 'hs110', 'hs200',
  'hs210', 'hs220', 'kl110', 'kl120', 'kl130', 'kl400', 'kl430', 'kl50', 'kl60',
  'kp105', 'kp115', 'kp405', 'ks200m', 'ks225', 'ks230', 'ks240',
  'lb100', 'lb110', 'lb120', 'lb130', 's500d'];
const CACHED = ['ep10', 'ep25', 'es20m', 'hs100', 'hs103', 'hs110', 'hs200',
  'hs210', 'hs220', 'kp105', 'kp115', 'kp405', 'ks225', 'ks230', 's500d'];

function expireStart(f) {
  const timer = f.device.pollStartTimer;
  assert.ok(f.timers.delete(timer));
  f.now += timer.delay;
  timer.callback();
}

for (const id of STAGGERED) {
  test(`${id}: first poll runs at the stagger deadline, then at the configured interval`, async () => {
    for (const random of [0, 0.5, 0.9999]) {
      const f = fixture(id, { random: () => random });
      const calls = [];
      f.device.getStatus = async () => { calls.push(f.now); };
      f.device.pollDevice(10);
      assert.equal(f.timers.size, 1);
      assert.equal(f.device.pollStartTimer.delay, Math.floor(random * 10000));
      assert.deepEqual(calls, []);
      expireStart(f);
      await flush();
      assert.deepEqual(calls, [Math.floor(random * 10000)]);
      assert.equal(f.timers.size, 1);
      const interval = f.device.pollingInterval;
      assert.equal(interval.delay, 10000);
      f.now += interval.delay;
      await interval.callback();
      assert.deepEqual(calls, [Math.floor(random * 10000), Math.floor(random * 10000) + 10000]);
      f.device.onDeleted();
      assert.equal(f.timers.size, 0);
    }
  });

  test(`${id}: replacement and deletion cancel polling before and after the first poll`, async () => {
    const f = fixture(id, { random: () => 0.5 });
    f.device.getStatus = async () => {};
    f.device.pollDevice(10);
    const first = f.device.pollStartTimer;
    f.device.pollDevice(20);
    assert.equal(f.timers.has(first), false);
    assert.equal(f.timers.size, 1);
    assert.equal(f.device.pollStartTimer.delay, 10000);
    expireStart(f);
    const interval = f.device.pollingInterval;
    f.device.pollDevice(30);
    assert.equal(f.timers.has(interval), false);
    assert.equal(f.timers.size, 1);
    assert.equal(f.device.pollStartTimer.delay, 15000);
    f.device.onDeleted();
    assert.equal(f.timers.size, 0);

    const pending = fixture(id, { random: () => 0.5 });
    let rejectPoll;
    pending.device.getStatus = () => new Promise((resolve, reject) => { rejectPoll = reject; });
    pending.device.pollDevice(10);
    expireStart(pending);
    assert.equal(typeof rejectPoll, 'function');
    pending.device.onDeleted();
    rejectPoll(new Error('offline during first poll'));
    await flush();
    assert.equal(pending.timers.size, 0);
    assert.ok(pending.logs.some(line => line.includes('offline during first poll')));
  });
}

function cachedFixture(id) {
  const f = fixture(id);
  f.plugs = [];
  f.statusRequests = 0;
  const instrumentClient = client => {
    const getPlug = client.getPlug.bind(client);
    client.getPlug = options => {
      // Match the actual library's identity fields so repeated polls use the cache.
      const plug = Object.assign(getPlug(options), { client, host: options.host });
      for (const method of ['getInfo', 'getSysInfo']) {
        const original = plug[method];
        plug[method] = async (...args) => { f.statusRequests++; return original(...args); };
      }
      f.plugs.push(plug);
      return plug;
    };
  };
  instrumentClient(f.device.client || f.clients[0]);
  f.instrumentClient = instrumentClient;
  return f;
}

for (const id of CACHED) {
  test(`${id}: cached polls fetch fresh status and replace the plug after an IP change`, async () => {
    const f = cachedFixture(id);
    await f.poll();
    const first = f.device.plug;
    f.sysInfo = { relay_state: 0, brightness: 25 };
    await f.poll(2);
    assert.equal(f.device.plug, first);
    assert.equal(f.plugs.length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.statusRequests, 3);
    assert.equal(f.device.values.onoff, false);
    if (id === 'hs220') assert.equal(f.device.values.dim, 0);
    f.device.settings.settingIPAddress = '192.0.2.20';
    await f.poll();
    assert.notEqual(f.device.plug, first);
    assert.equal(f.plugs.length, 2);
    assert.equal(f.requests.at(-1), '192.0.2.20');
  });

  test(`${id}: a cached connection outage still rediscovers and resumes telemetry`, async () => {
    const f = cachedFixture(id);
    await f.poll();
    const first = f.device.plug;
    f.infoError = new Error('TCP Timeout after 10000ms');
    await f.poll(3);
    assert.equal(f.device.plug, first);
    assert.equal(f.device.available, false);
    assert.equal(f.device.discoverCount, 1);
    const scan = f.clients.at(-1);
    scan.emit('plug-new', {
      deviceId: 'plug-1', host: '192.0.2.20', model: id.toUpperCase(),
      defaultSendOptions: { transport: 'tcp' },
      getSysInfo: async () => ({ deviceId: 'plug-1', model: id.toUpperCase() }),
    });
    await flush();
    assert.equal(f.device.settings.settingIPAddress, '192.0.2.20');
    assert.equal(scan.stops, 1);
    f.infoError = null;
    await f.poll();
    assert.equal(f.device.available, true);
    assert.equal(f.device.values.onoff, true);
    assert.notEqual(f.device.plug, first);
    f.device.onDeleted();
    assert.equal(f.timers.size, 0);
  });
}

for (const id of ['ep10', 'hs210', 'hs220', 'ks225', 's500d']) {
  test(`${id}: replacing the authenticated client invalidates its cached plug`, async () => {
    const f = cachedFixture(id);
    await f.poll();
    const first = f.device.plug;
    const Client = f.device.client.constructor;
    f.device.client = new Client({ defaultSendOptions: { transport: 'klap' } });
    f.instrumentClient(f.device.client);
    await f.poll();
    assert.notEqual(f.device.plug, first);
    assert.equal(f.device.plug.client, f.device.client);
    assert.equal(f.device.plug.host, first.host);
    assert.equal(f.requests.length, 2);
  });
}

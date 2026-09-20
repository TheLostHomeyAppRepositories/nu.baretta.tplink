'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadFreshModule(modulePath, stubs) {
  const resolvedPath = require.resolve(modulePath);
  const previousModule = require.cache[resolvedPath];
  const originalLoad = Module._load;

  delete require.cache[resolvedPath];
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(resolvedPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolvedPath];
    if (previousModule) require.cache[resolvedPath] = previousModule;
  }
}

function createAppClass(Client = class Client {}) {
  return loadFreshModule('../app.js', {
    homey: { App: class App {} },
    'tplink-smarthome-api': { Client },
  });
}

function createSettings(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get(key) {
      return values[key];
    },
    set(key, value) {
      values[key] = value;
    },
    unset(key) {
      delete values[key];
    },
  };
}

test('brightness Flow survives mixed device initialization and preserves percentage units', async () => {
  const { fixture } = require('./helpers/tplink-device-fixture');
  const listeners = new Map();
  let registrations = 0;
  const flow = {
    getActionCard(id) {
      return { registerRunListener(listener) {
        if (id === 'set_brightness') registrations++;
        listeners.set(id, listener);
      } };
    },
  };
  const app = await createApp({ flow });
  await app.onInit();
  const devices = [];
  for (const id of ['ks240', 'hs220', 'es20m', 'kp405', 'ks225', 'ks230', 's500d', 'ks240']) {
    const { device } = fixture(id);
    device.homey.flow = flow;
    device.getStatus = async () => {};
    device.pollDevice = () => {};
    await device.onInit();
    devices.push(device);
  }
  assert.equal(registrations, 1);
  const run = listeners.get('set_brightness');
  for (const device of devices) {
    const calls = [];
    if (typeof device.setLevel === 'function') {
      device.setLevel = async level => { calls.push(level); };
      for (const brightness of [0, 1, 50, 100]) {
        assert.equal(await run({ device, brightness }), true);
      }
      assert.deepEqual(calls, [0, 0.01, 0.5, 1]);
    } else {
      device.setBrightness = async (host, brightness) => { calls.push({ host, brightness }); };
      assert.equal(await run({ device, brightness: 50 }), true);
      assert.deepEqual(calls, [{ host: device.getSettings().settingIPAddress, brightness: 50 }]);
    }
  }
  const device = devices[1];
  device.setBrightness = async () => false;
  assert.equal(await run({ device, brightness: 50 }), false);
  const failure = new Error('device unreachable');
  device.setBrightness = async () => { throw failure; };
  await assert.rejects(run({ device, brightness: 50 }), error => error === failure);
  for (const brightness of [NaN, Infinity, -1, 101, '50']) {
    await assert.rejects(run({ device, brightness }), /Brightness must be/);
  }
});

test('LED Flows keep one app listener across every driver and device initialization order', async () => {
  const { fixture } = require('./helpers/tplink-device-fixture');
  const ids = require('../app.json').drivers.map(driver => driver.id);
  for (const order of [ids, [...ids].reverse()]) {
    const listeners = new Map();
    const registrations = new Map();
    const flow = { getActionCard: id => ({ registerRunListener(listener) {
      listeners.set(id, listener);
      registrations.set(id, (registrations.get(id) || 0) + 1);
    } }) };
    const app = await createApp({ flow });
    await app.onInit();
    const devices = [];
    for (const id of order) {
      const Driver = loadFreshModule(`../drivers/${id}/driver.js`, {
        homey: { Driver: class Driver {} },
        'tplink-smarthome-api': { Client: class Client {} },
      });
      const driver = new Driver();
      driver.homey = { flow };
      driver.log = () => {};
      if (driver.onInit) await driver.onInit();
      const { device } = fixture(id);
      device.homey.flow = flow;
      device.getStatus = async () => {};
      device.pollDevice = () => {};
      device.startPolling = () => {};
      await device.onInit();
      devices.push(device);
    }
    assert.equal(registrations.get('ledOn'), 1);
    assert.equal(registrations.get('ledOff'), 1);
    for (const device of devices) {
      const calls = [];
      const host = device.getSettings().settingIPAddress;
      const childId = device.getData().childId;
      if (typeof device.setLedState === 'function') {
        device.setLedState = async (...args) => { calls.push(args); };
        assert.equal(await listeners.get('ledOn')({ device }), true);
        assert.equal(await listeners.get('ledOff')({ device }), true);
        assert.deepEqual(calls, [[host, childId, true], [host, childId, false]]);
      } else if (typeof device.ledOn === 'function') {
        device.ledOn = async (...args) => { calls.push(['on', ...args]); };
        device.ledOff = async (...args) => { calls.push(['off', ...args]); };
        assert.equal(await listeners.get('ledOn')({ device }), true);
        assert.equal(await listeners.get('ledOff')({ device }), true);
        assert.deepEqual(calls, [['on', host, childId], ['off', host, childId]]);
      }
    }
  }
});

test('LED Flow dispatch preserves device failures for both LED interfaces', async () => {
  const listeners = new Map();
  await createApp({ flow: { getActionCard: id => ({ registerRunListener: listener => listeners.set(id, listener) }) } });
  for (const method of ['setLedState', 'ledOn', 'ledOff']) {
    const device = {
      getSettings: () => ({ settingIPAddress: '192.0.2.10' }),
      getData: () => ({ childId: 'child-1' }),
      [method]: async () => false,
    };
    const run = listeners.get(method === 'ledOff' ? 'ledOff' : 'ledOn');
    assert.equal(await run({ device }), false);
    const failure = new Error('LED request failed');
    device[method] = async () => { throw failure; };
    await assert.rejects(run({ device }), error => error === failure);
  }
});

test('authenticated HS220 participates in saved-account validation and refresh using its persisted transport', async () => {
  const options = [];
  const refreshes = [];
  class Client {
    constructor(value) { options.push(value); }
    async getSysInfo(host) { assert.equal(host, '192.0.2.101'); return { model: 'HS220(US)' }; }
  }
  const device = {
    getData: () => ({ id: 'hs220', transport: 'klap' }),
    getSettings: () => ({ settingIPAddress: '192.0.2.101', credentialSource: 'global' }),
    async refreshGlobalCredentials(value) { refreshes.push(value); return true; },
  };
  const app = await createApp({ Client, drivers: {
    hs220: { id: 'hs220', getDevices: () => [device] },
  } });
  const account = { username: 'owner@example.com', password: 'secret' };
  const result = await app.saveGlobalCredentials(account);
  assert.equal(result.status.validation.status, 'validated');
  assert.equal(options[0].defaultSendOptions.transport, 'klap');
  assert.deepEqual(options[0].credentials, account);
  assert.equal(refreshes.length, 1);
  await app.clearGlobalCredentials();
  assert.equal(refreshes.length, 2);
});

test('HS210 credential validation uses the recovered protocol even when pairing data says TCP', async () => {
  const calls = [];
  class Client {
    constructor(options) { calls.push(options); }
    async getSysInfo() { return { model: 'HS210' }; }
  }
  const account = { username: 'owner@example.com', password: 'secret' };
  const device = {
    getData: () => ({ id: 'existing', transport: 'tcp' }),
    getSettings: () => ({ settingIPAddress: '192.0.2.75' }),
    getStoreValue: () => ({ host: '192.0.2.75', transport: 'klap', protocol: 'iot' }),
    async refreshGlobalCredentials() { return true; },
  };
  const app = await createApp({ Client, drivers: { hs210: { getDevices: () => [device] } } });
  assert.equal((await app.saveGlobalCredentials(account)).status.validation.status, 'validated');
  assert.equal(calls[0].defaultSendOptions.transport, 'klap');
  assert.equal(calls[0].defaultSendOptions.protocol, 'iot');
});

async function createApp({ settings = {}, drivers = {}, Client, flow = { getActionCard: () => ({ registerRunListener() {} }) } } = {}) {
  const App = createAppClass(Client);
  const app = new App();
  app.homey = {
    __: key => key === 'flowErrors.invalidBrightness' ? 'Brightness must be a number between 0 and 100.' : key,
    settings: createSettings(settings),
    flow,
    drivers: {
      getDrivers() {
        return drivers;
      },
    },
  };
  app.log = () => {};
  app.error = () => {};
  await app.onInit();
  return app;
}

test('saved credentials can be tested before pairing, with honest status after failures, replacement and restart', async () => {
  const calls = [];
  let fail = false;
  class Client {
    constructor(options) { this.options = options; }
    async getSysInfo(host, port, options) {
      calls.push({ host, options, credentials: this.options.credentials });
      if (!options) throw new Error(`AesConnection(AES ${host}:80): handshake failed with error_code 1003`);
      if (fail) throw new Error('KlapConnection: authentication failed (challenge mismatch) secret-password');
      return { model: 'KS240(US)', deviceId: 'ks240-parent' };
    }
  }
  const app = await createApp({ Client });
  const account = { username: 'owner@example.com', password: 'secret-password' };
  assert.equal((await app.saveGlobalCredentials(account)).status.validation.status, 'unverified');
  const api = require('../api');
  let result = await api.testCredentials({ homey: { app }, body: { ip: '192.168.10.103' } });
  assert.equal(result.status.validation.status, 'validated');
  assert.ok(result.status.validation.checkedAt);
  assert.equal((await app.getCredentialStatus()).validation.status, 'validated');
  assert.deepEqual(calls[1].credentials, account);
  assert.equal(calls[1].options.transport, 'klap');
  assert.equal(JSON.stringify(result).includes(account.password), false);
  fail = true;
  result = await app.testGlobalCredentials({ ip: '192.168.10.103' });
  assert.equal(result.status.validation.status, 'rejected');
  assert.match(result.validation.error, /challenge mismatch/);
  assert.equal(JSON.stringify(result).includes(account.password), false);
  assert.deepEqual(app.getGlobalCredentials(), account);
  fail = false;
  await app.testGlobalCredentials({ ip: '192.168.10.103' });
  await app.saveGlobalCredentials({ username: 'new@example.com', password: 'new-password' });
  assert.equal((await app.getCredentialStatus()).validation.status, 'unverified');
  await app.testGlobalCredentials({ ip: '192.168.10.103' });
  await app.onInit();
  assert.equal((await app.getCredentialStatus()).validation.status, 'unverified');
  await app.clearGlobalCredentials();
  assert.equal((await app.getCredentialStatus()).configured, false);
  await assert.rejects(app.testGlobalCredentials({ ip: '192.168.10.103' }), /Save the TP-Link account/);
});

test('credential testing rejects malformed targets before sending credentials and preserves offline as unverified', async () => {
  let calls = 0;
  class Client {
    async getSysInfo() { calls++; throw new Error('connect ECONNREFUSED 192.0.2.1:80'); }
  }
  const app = await createApp({ Client, settings: {
    tplinkCredentials: { username: 'owner@example.com', password: 'secret' },
  } });
  for (const ip of ['http://example.com', '192.0.2.1:80', '::1', {}, 123, 0, false, null]) {
    await assert.rejects(app.testGlobalCredentials({ ip }), /valid device IPv4/);
  }
  assert.equal(calls, 0);
  assert.equal((await app.testGlobalCredentials({ ip: '192.0.2.1' })).validation.status, 'unverified');
  assert.equal(calls, 1);
});

test('credential status and private API results never expose the password', async () => {
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'account@example.com',
        password: 'do-not-return-this-password',
      },
    },
  });
  const api = require('../api');

  const status = await api.getCredentialStatus({ homey: { app } });
  assert.equal(status.configured, true);
  assert.equal(status.usernameHint, 'a***@example.com');
  assert.equal(JSON.stringify(status).includes('do-not-return-this-password'), false);

  const saved = await api.saveCredentials({
    homey: { app },
    body: { username: 'new@example.com', password: 'never-return-this-one' },
  });
  assert.equal(saved.validation.status, 'unverified');
  assert.equal(JSON.stringify(saved).includes('never-return-this-one'), false);
});

test('credential summary omits confirmed TCP EP10s but retains authenticated devices', async () => {
  const createDevice = (id, data, settings) => ({
    getData() {
      return { id, ...data };
    },
    getSettings() {
      return settings;
    },
  });
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'account@example.com',
        password: 'account password',
      },
    },
    drivers: {
      ep10: {
        id: 'ep10',
        getDevices() {
          return [
            createDevice(
              'tcp-ep10',
              { transport: 'tcp' },
              { credentialSource: 'global' },
            ),
            createDevice(
              'authenticated-ep10',
              { transport: 'klap' },
              { credentialSource: 'global' },
            ),
          ];
        },
      },
      ks225: {
        id: 'ks225',
        getDevices() {
          return [
            createDevice(
              'authenticated-strict-device',
              {},
              { credentialSource: 'global' },
            ),
          ];
        },
      },
    },
  });

  assert.deepEqual((await app.getCredentialStatus()).devices, {
    global: 2,
    override: 0,
    legacy: 0,
    unavailable: 0,
  });
});

test('first authenticated pairing seeds the atomic global pair and later differing pairs stay overrides', async () => {
  const app = await createApp();
  const first = await app.finalizePairingCredentials({
    credentials: { username: 'first@example.com', password: 'first password' },
  });

  assert.equal(first.source, 'global');
  assert.deepEqual(app.homey.settings.values.tplinkCredentials, {
    username: 'first@example.com',
    password: 'first password',
  });
  assert.deepEqual(first.settings, {
    credentialSource: 'global',
    deviceUsername: '',
    devicePassword: '',
  });

  const second = await app.finalizePairingCredentials({
    credentials: { username: 'other@example.com', password: 'other password' },
  });
  assert.equal(second.source, 'override');
  assert.deepEqual(app.homey.settings.values.tplinkCredentials, {
    username: 'first@example.com',
    password: 'first password',
  });
  assert.deepEqual(second.settings, {
    credentialSource: 'override',
    deviceUsername: 'other@example.com',
    devicePassword: 'other password',
  });
});

test('explicit adoption persists global source before clearing matching legacy copies and is idempotent', async () => {
  const settings = {
    settingIPAddress: '192.0.2.20',
    deviceUsername: 'global@example.com',
    devicePassword: 'global password',
  };
  const writes = [];
  let refreshCalls = 0;
  const device = {
    getData() {
      return { id: 'legacy-device' };
    },
    getSettings() {
      return settings;
    },
    async setSettings(update) {
      writes.push(update);
      Object.assign(settings, update);
    },
    async refreshGlobalCredentials() {
      refreshCalls += 1;
      return true;
    },
  };
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'global@example.com',
        password: 'global password',
      },
    },
    drivers: {
      ks225: {
        id: 'ks225',
        getDevices() {
          return [device];
        },
      },
    },
  });

  const first = await app.adoptMatchingLegacyDevices();
  assert.deepEqual(first.adopted, ['ks225:legacy-device']);
  assert.deepEqual(writes, [
    { credentialSource: 'global' },
    { deviceUsername: '', devicePassword: '' },
  ]);
  assert.equal(refreshCalls, 1);

  const second = await app.adoptMatchingLegacyDevices();
  assert.deepEqual(second.adopted, []);
  assert.deepEqual(second.skipped, ['ks225:legacy-device']);
  assert.equal(refreshCalls, 1);
});

test('a global credential update refreshes global and legacy-fallback devices, but not local overrides', async () => {
  const refreshes = [];
  const createDevice = (id, settings) => ({
    getData() {
      return { id };
    },
    getSettings() {
      return settings;
    },
    async refreshGlobalCredentials(options) {
      refreshes.push({ id, options });
      return true;
    },
  });
  const globalDevice = createDevice('global', {
    settingIPAddress: '192.0.2.41',
    credentialSource: 'global',
  });
  const overrideDevice = createDevice('override', {
    settingIPAddress: '192.0.2.42',
    credentialSource: 'override',
    deviceUsername: 'other@example.com',
    devicePassword: 'other password',
  });
  const legacyLocalDevice = createDevice('legacy-local', {
    settingIPAddress: '192.0.2.43',
    deviceUsername: 'legacy@example.com',
    devicePassword: 'legacy password',
  });
  const legacyFallbackDevice = createDevice('legacy-fallback', {
    settingIPAddress: '192.0.2.44',
  });
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'old@example.com',
        password: 'old password',
      },
    },
    drivers: {
      ks225: {
        id: 'ks225',
        getDevices() {
          return [
            globalDevice,
            overrideDevice,
            legacyLocalDevice,
            legacyFallbackDevice,
          ];
        },
      },
    },
  });

  const result = await app.saveGlobalCredentials({
    username: 'new@example.com',
    password: 'new password',
  });

  assert.equal(result.validation.status, 'unverified');
  assert.deepEqual(app.homey.settings.values.tplinkCredentials, {
    username: 'new@example.com',
    password: 'new password',
  });
  assert.deepEqual(
    refreshes.map(refresh => refresh.id).sort(),
    ['global', 'legacy-fallback'],
  );
  assert.equal(refreshes.every(refresh => refresh.options.version === 1), true);
});

test('global credential validation tries distinct eligible targets after an inconclusive result', async () => {
  const calls = [];
  class Client {
    constructor(options) {
      this.options = options;
    }

    async getSysInfo(ipAddress) {
      calls.push(ipAddress);
      if (ipAddress === '192.0.2.61') {
        throw new Error('ETIMEDOUT while validating account credentials');
      }
      return { deviceId: ipAddress };
    }
  }
  const createDevice = (id, ipAddress) => ({
    getData() {
      return { id };
    },
    getSettings() {
      return {
        settingIPAddress: ipAddress,
        credentialSource: 'global',
      };
    },
  });
  const app = await createApp({
    Client,
    drivers: {
      ks240: {
        id: 'ks240',
        getDevices() {
          return [
            createDevice('ks240-light', '192.0.2.61'),
            createDevice('ks240-fan', '192.0.2.61'),
          ];
        },
      },
      ks225: {
        id: 'ks225',
        getDevices() {
          return [createDevice('ks225', '192.0.2.62')];
        },
      },
    },
  });

  const result = await app.validateGlobalCredentials({
    username: 'account@example.com',
    password: 'password',
  });

  assert.equal(result.status, 'validated');
  assert.deepEqual(calls, ['192.0.2.61', '192.0.2.62']);
});

test('a fulfilled false global refresh is reported as failed', async () => {
  const device = {
    getData() {
      return { id: 'global-device' };
    },
    getSettings() {
      return {
        settingIPAddress: '192.0.2.70',
        credentialSource: 'global',
      };
    },
    async refreshGlobalCredentials() {
      return false;
    },
  };
  const app = await createApp({
    drivers: {
      ks225: {
        id: 'ks225',
        getDevices() {
          return [device];
        },
      },
    },
  });

  assert.deepEqual(
    await app.refreshDevicesUsingGlobalCredentials({ reason: 'test' }),
    { attempted: 1, refreshed: 0, failed: 1 },
  );
});

for (const driverId of ['ep10', 'hs210', 'hs220']) {
test(`an unmarked pre-transport ${driverId} is not selected for global auth validation or refresh`, async () => {
  let refreshCalls = 0;
  const device = {
    getData() {
      return { id: 'legacy-ep10' };
    },
    getSettings() {
      return { settingIPAddress: '192.0.2.71' };
    },
    async refreshGlobalCredentials() {
      refreshCalls += 1;
      return true;
    },
  };
  const app = await createApp({
    settings: {
      tplinkCredentials: {
        username: 'account@example.com',
        password: 'password',
      },
    },
    drivers: {
      [driverId]: {
        id: driverId,
        getDevices() {
          return [device];
        },
      },
    },
  });
  const entry = app.getManagedDevices()[0];

  assert.equal(
    app.isEligibleValidationDevice(entry, {
      username: 'account@example.com',
      password: 'password',
    }),
    false,
  );
  assert.deepEqual(
    await app.refreshDevicesUsingGlobalCredentials({ reason: 'test' }),
    { attempted: 0, refreshed: 0, failed: 0 },
  );
  assert.equal(refreshCalls, 0);
});
}

test('an explicitly global pre-transport EP10 refreshes when the global pair is cleared', async () => {
  let refreshCalls = 0;
  const device = {
    getData() {
      return { id: 'global-ep10' };
    },
    getSettings() {
      return {
        settingIPAddress: '192.0.2.72',
        credentialSource: 'global',
      };
    },
    async refreshGlobalCredentials() {
      refreshCalls += 1;
      return true;
    },
  };
  const app = await createApp({
    drivers: {
      ep10: {
        id: 'ep10',
        getDevices() {
          return [device];
        },
      },
    },
  });

  assert.deepEqual(
    await app.refreshDevicesUsingGlobalCredentials({ reason: 'global cleared' }),
    { attempted: 1, refreshed: 1, failed: 0 },
  );
  assert.equal(refreshCalls, 1);
});

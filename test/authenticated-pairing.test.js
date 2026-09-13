'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { EventEmitter } = require('node:events');

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

function createHomeyStub() {
  return {
    Driver: class Driver {
      getDevices() {
        return [];
      }

      log() {}
    },
  };
}

function createPairSession() {
  const handlers = new Map();
  const emitted = [];
  return {
    handlers,
    emitted,
    setHandler(name, handler) {
      handlers.set(name, handler);
    },
    async emit(name, value) {
      emitted.push({ name, value });
    },
  };
}

test('KS240 manual pairing preserves both child IDs and KLAP metadata after AES rejection', async () => {
  const { Client: RealClient } = require('tplink-smarthome-api');
  let calls = 0;
  class Client extends RealClient {
    async getSysInfo(host, port, options) {
      calls++;
      if (!options) throw new Error(`AesConnection(AES ${host}:80): handshake failed with error_code 1003`);
      assert.equal(options.transport, 'klap');
      return { model: 'KS240(US)', deviceId: 'parent', type: 'SMART.KASASWITCH',
        mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 } };
    }
    getPlug(options) {
      const plug = super.getPlug(options);
      assert.equal(plug.defaultSendOptions.transport, 'klap');
      plug.sendSmartRequests = async requests => {
        assert.deepEqual(requests, [{ method: 'get_child_device_list' }]);
        return { get_child_device_list: { child_device_list: [
          { device_id: 'fan-id', category: 'kasa.switch.outlet.sub-fan' },
          { device_id: 'light-id', category: 'kasa.switch.outlet.sub-dimmer' },
        ] } };
      };
      return plug;
    }
  }
  const Driver = loadFreshModule('../drivers/ks240/driver.js', {
    homey: createHomeyStub(), 'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  await driver.onPair(session);
  const devices = await session.handlers.get('get_devices')({ ip: '192.168.10.103',
    deviceUsername: 'owner@example.com', devicePassword: 'secret' });
  assert.equal(calls, 2);
  assert.deepEqual(devices.map(device => device.data.id), ['fan-id', 'light-id']);
  assert.deepEqual(devices.map(device => device.data.channelType), ['fan', 'light']);
  assert.ok(devices.every(device => device.data.parentId === 'parent'));
});

test('KS240 discovery followed by Next uses the authenticated parent ID and still rejects a replacement device', async () => {
  const { Client: RealClient } = require('tplink-smarthome-api');
  const info = { deviceId: 'canonical-parent', model: 'KS240(US)', type: 'SMART.KASASWITCH',
    mac: '00:11:22:33:44:55', alias: 'KS240', sw_ver: '1.0', hw_ver: '1.0',
    mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 } };
  const children = [
    { device_id: 'light-channel', category: 'kasa.switch.outlet.sub-dimmer' },
    { device_id: 'fan-channel', category: 'kasa.switch.outlet.sub-fan' },
  ];
  let replacement = false;
  let timer;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  class Client extends RealClient {
    async getSysInfo() { return { ...info, deviceId: replacement ? 'replacement-parent' : info.deviceId }; }
    getPlug(options) {
      const plug = super.getPlug(options);
      plug.sendSmartCommand = async () => ({ device_id: info.deviceId, device_on: true });
      plug.sendSmartRequests = async requests => requests.some(request => request.method === 'get_child_device_list')
        ? { get_child_device_list: { child_device_list: children } } : {};
      return plug;
    }
    startDiscovery() {
      this.emit('new', this.getPlug({ host: '192.0.2.103', sysInfo: { ...info, deviceId: 'discovery-hash' } }));
    }
    stopDiscovery() {}
  }
  const Driver = loadFreshModule('../drivers/ks240/driver.js', {
    homey: createHomeyStub(), 'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const logs = [];
  driver.log = line => logs.push(line);
  const session = createPairSession();
  await driver.onPair(session);
  const credentials = { deviceUsername: 'owner@example.com', devicePassword: 'pairing-secret' };
  global.setTimeout = callback => { timer = callback; return 1; };
  global.clearTimeout = () => {};
  try {
    const pending = session.handlers.get('discover')(credentials);
    await new Promise(resolve => setImmediate(resolve));
    timer();
    const discovered = await pending;
    assert.equal(discovered.length, 2, logs.join('\n'));
    assert.ok(discovered.every(device => device.settings.deviceId === 'canonical-parent'));
    const selected = discovered.map(device => ({ ...device, settings: { ...device.settings, ...credentials } }));
    const paired = await session.handlers.get('get_devices')(selected);
    assert.deepEqual(paired.map(device => device.data.id), ['light-channel', 'fan-channel']);
    assert.ok(paired.every(device => device.data.parentId === 'canonical-parent'));
    assert.ok(logs.some(line => line.includes('discovery parent=') && line.includes('authenticated parent=')));
    assert.ok(logs.some(line => line.includes('2 validated channels ready')));
    assert.equal(logs.join('\n').includes('pairing-secret'), false);
    assert.equal(logs.join('\n').includes('owner@example.com'), false);
    replacement = true;
    await assert.rejects(session.handlers.get('get_devices')(selected), /no longer matches/);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('KS240 discovery filters other models, avoids repeated auth attempts, and reports challenge mismatch', async () => {
  let client;
  let authCalls = 0;
  let otherCalls = 0;
  let timer;
  let cleared = false;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  class Client extends EventEmitter {
    constructor() { super(); client = this; }
    startDiscovery(options) {
      assert.equal(options.filterCallback({ model: 'HS220(US)' }), false);
      assert.equal(options.filterCallback({ model: 'KS240(US)' }), true);
      this.emit('plug-new', { model: 'HS220(US)', deviceId: 'other', getSysInfo: async () => otherCalls++ });
      this.target = { model: 'KS240(US)', deviceId: 'ks240', host: '192.168.10.103', getSysInfo: async () => {
        authCalls++;
        throw new Error('KlapConnection: authentication failed (challenge mismatch) pairing-secret');
      } };
      this.emit('plug-new', this.target);
    }
    stopDiscovery() { this.stopped = true; }
  }
  const Driver = loadFreshModule('../drivers/ks240/driver.js', {
    homey: createHomeyStub(), 'tplink-smarthome-api': { Client },
  });
  const session = createPairSession();
  await new Driver().onPair(session);
  global.setTimeout = callback => { timer = callback; return 1; };
  global.clearTimeout = () => { cleared = true; };
  try {
    const discovery = session.handlers.get('discover')({ deviceUsername: 'owner@example.com', devicePassword: 'pairing-secret' });
    const rejection = assert.rejects(discovery, error => /challenge mismatch/.test(error.message) && !error.message.includes('pairing-secret'));
    await new Promise(resolve => setImmediate(resolve));
    client.emit('plug-online', client.target);
    timer();
    await rejection;
    assert.equal(authCalls, 1);
    assert.equal(otherCalls, 0);
    assert.equal(client.stopped, true);
    assert.equal(client.eventNames().length, 0);
    assert.equal(cleared, true);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('KS225 refuses missing credentials and validates the physical selected target before returning a pair device', async () => {
  const instances = [];
  class Client {
    constructor(options) {
      this.options = options;
      instances.push(this);
    }

    async getSysInfo(host) {
      assert.equal(host, '192.0.2.30');
      return { model: 'KS225(US)', deviceId: 'physical-ks225', alias: 'Kitchen' };
    }
  }
  const Driver = loadFreshModule('../drivers/ks225/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  await driver.onPair(session);

  await assert.rejects(
    session.handlers.get('get_devices')([{ ip: '192.0.2.30', name: 'Kitchen' }]),
    /credentials are required/,
  );

  const devices = await session.handlers.get('get_devices')([
    {
      ip: '192.0.2.30',
      name: 'Kitchen',
      deviceId: 'physical-ks225',
      deviceUsername: ' account@example.com ',
      devicePassword: ' password ',
    },
  ]);

  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].options, {
    defaultSendOptions: { transport: 'klap', timeout: 4000 },
    credentials: { username: 'account@example.com', password: ' password ' },
  });
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].settings, {
    settingIPAddress: '192.0.2.30',
    dynamicIp: false,
    totalOffset: 0,
    deviceId: 'physical-ks225',
    credentialSource: 'global',
    deviceUsername: '',
    devicePassword: '',
  });
  assert.deepEqual(session.emitted, [{ name: 'continue', value: null }]);
});

test('KS225 rejects a stale discovery selection when the authenticated target has another device ID', async () => {
  class Client {
    async getSysInfo() {
      return { model: 'KS225', deviceId: 'other-device' };
    }
  }
  const Driver = loadFreshModule('../drivers/ks225/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  await driver.onPair(session);

  await assert.rejects(
    session.handlers.get('get_devices')([
      {
        ip: '192.0.2.31',
        deviceId: 'selected-device',
        deviceUsername: 'account@example.com',
        devicePassword: 'password',
      },
    ]),
    /no longer matches the device selected during discovery/,
  );
});

test('KS225 redacts a target-validation error before returning it to the pairing UI', async () => {
  class Client {
    async getSysInfo() {
      throw new Error('Target validation echoed pairing-secret');
    }
  }
  const Driver = loadFreshModule('../drivers/ks225/driver.js', {
    homey: createHomeyStub(),
    'tplink-smarthome-api': { Client },
  });
  const driver = new Driver();
  const session = createPairSession();
  await driver.onPair(session);

  let error;
  try {
    await session.handlers.get('get_devices')([
      {
        ip: '192.0.2.32',
        deviceUsername: 'account@example.com',
        devicePassword: 'pairing-secret',
      },
    ]);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.match(error.message, /Unable to validate the selected KS225/);
  assert.equal(error.message.includes('pairing-secret'), false);
});

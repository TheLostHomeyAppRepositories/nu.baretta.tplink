'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('tplink-smarthome-api');
const { fixture } = require('./helpers/tplink-device-fixture');

function controlFixture() {
  const fanId = 'test-parent-channel-00';
  const lightId = 'test-parent-channel-01';
  const states = {
    [fanId]: { device_on: false, fan_speed_level: 2 },
    [lightId]: { device_on: true, brightness: 35 },
  };
  const sent = [];
  let parentReads = 0;
  let rejectCommand = false;
  class MockNetworkClient extends Client {
    async getSysInfo(host, port, options) {
      parentReads++;
      if (!options) throw new Error(`AesConnection(AES ${host}:80): handshake failed with error_code 1003`);
      assert.equal(options.transport, 'klap');
      return { deviceId: 'parent', model: 'KS240(US)', type: 'SMART.KASASWITCH',
        alias: 'Parent', mac: '00:11:22:33:44:55', sw_ver: '1.0.9', hw_ver: '1.0',
        device_on: true, brightness: 99, fan_speed_level: 4,
        mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 } };
    }
    getPlug(options) {
      // Exercise the real constructor and SMART wire envelope. Parent info
      // deliberately has no children, matching the failing physical device.
      const plug = super.getPlug(options);
      assert.equal(plug.childId, undefined);
      assert.equal(plug.sysInfo.children, undefined);
      plug.send = async (payload, sendOptions) => {
        payload = JSON.parse(JSON.stringify(payload));
        assert.equal(sendOptions.transport, 'klap');
        assert.equal(payload.method, 'control_child');
        const { device_id: childId, requestData } = payload.params;
        assert.ok(Object.hasOwn(states, childId), 'Every request must target the selected channel');
        sent.push({ childId, ...requestData });
        if (rejectCommand) return JSON.stringify({ error_code: -1008 });
        if (requestData.method === 'set_device_info') Object.assign(states[childId], requestData.params);
        else assert.equal(requestData.method, 'get_device_info');
        return JSON.stringify({ error_code: 0, result: { responseData: {
          error_code: 0, result: { device_id: childId, ...states[childId] },
        } } });
      };
      return plug;
    }
  }
  const f = fixture('ks240', { Client: MockNetworkClient });
  f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
  const makeChannel = (childId, channelType) => {
    const device = f.makeDevice({ deviceId: 'parent', childId, channelType, credentialSource: 'global' });
    device.getData = () => ({ id: childId, parentId: 'parent', childId, channelType });
    device.getClass = () => channelType === 'fan' ? 'fan' : 'light';
    return device;
  };
  return { f, states, sent, fanId, lightId,
    fan: makeChannel(fanId, 'fan'), light: makeChannel(lightId, 'light'),
    get parentReads() { return parentReads; },
    rejectCommands() { rejectCommand = true; },
  };
}

test('KS240 initializes without a cached child list and routes independent polling/control through control_child', async () => {
  const c = controlFixture();
  await c.fan.onInit();
  await c.light.onInit();
  assert.equal(c.fan.values.onoff, false);
  assert.equal(c.fan.values.dim, 0.5);
  assert.equal(c.light.values.onoff, true);
  assert.equal(c.light.values.dim, 0.35);
  assert.equal(c.f.logs.some(line => line.includes('Status polling failed')), false);

  await c.fan.onCapabilityOnoff(true);
  assert.deepEqual(c.sent.at(-1), { childId: c.fanId, method: 'set_device_info',
    params: { device_on: true, fan_speed_level: 2 } });
  await c.fan.onCapabilityDim(0.75);
  assert.equal(c.states[c.fanId].fan_speed_level, 3);
  await c.light.onCapabilityDim(0.6);
  assert.equal(c.states[c.lightId].brightness, 60);
  await c.fan.onCapabilityOnoff(false);
  assert.equal(c.states[c.fanId].device_on, false);
  await c.light.onCapabilityOnoff(false);
  await c.light.onCapabilityOnoff(true);
  assert.deepEqual(c.sent.at(-1), { childId: c.lightId, method: 'set_device_info', params: { device_on: true } });

  c.states[c.fanId] = { device_on: true, fan_speed_level: 4 };
  c.states[c.lightId] = { device_on: true, brightness: 22 };
  await c.fan.getStatus();
  await c.light.getStatus();
  assert.equal(c.fan.values.dim, 1);
  assert.equal(c.light.values.dim, 0.22);
  assert.equal(await c.fan.refreshGlobalCredentials({ reason: 'test' }), true);
  assert.ok((await c.light.validateCredentialTransition(c.light.getSettings())).plug);
  await c.fan.reinitializeConnection(c.fan.getSettings().settingIPAddress);
  await c.fan.onInit();
  await c.light.onInit();
  assert.equal(c.fan.childId, c.fanId);
  assert.equal(c.light.childId, c.lightId);
  assert.equal(c.f.timers.size, 2);
  assert.equal(c.fan.values.dim, 1);
  assert.equal(c.light.values.dim, 0.22);
  c.fan.onDeleted();
  c.light.onDeleted();
  assert.equal(c.f.timers.size, 0);
});

test('KS240 rejects missing child identity before making a parent or child request', async () => {
  const c = controlFixture();
  c.fan.childId = '';
  await assert.rejects(c.fan.setPowerState(true), /missing its child ID/);
  await assert.rejects(c.fan.setLevel(0.5), /missing its child ID/);
  assert.equal(c.parentReads, 0);
  assert.equal(c.sent.length, 0);
});

test('KS240 labels only the fan slider and preserves its options idempotently', async () => {
  const c = controlFixture();
  c.fan.capabilityOptions.dim = { preventInsights: true };
  await c.fan.onInit();
  await c.light.onInit();
  assert.equal(c.fan.capabilityOptions.dim.title.en, 'Fan level');
  assert.equal(c.fan.capabilityOptions.dim.title.nl, 'Ventilatorstand');
  assert.equal(c.fan.capabilityOptions.dim.preventInsights, true);
  assert.equal(c.fan.optionWrites.length, 1);
  assert.equal(c.light.optionWrites.length, 0);
  await c.fan.onInit();
  assert.equal(c.fan.optionWrites.length, 1);
  c.fan.capabilityOptions.dim = {};
  c.fan.setCapabilityOptions = async () => { throw new Error('Option write failed'); };
  await c.fan.onInit();
  assert.equal(c.fan.values.dim, 0.5);
  assert.ok(c.f.logs.some(line => line.includes('Option write failed')));
});

test('KS240 propagates rejected child commands without reporting a successful capability update', async () => {
  const c = controlFixture();
  await c.light.onInit();
  c.rejectCommands();
  await assert.rejects(c.light.onCapabilityDim(0.8), /SMART/);
  assert.equal(c.light.values.dim, 0.35);
  await c.light.getStatus();
  assert.ok(c.f.logs.some(line => line.includes('Status polling failed')));
  c.light.onDeleted();
});

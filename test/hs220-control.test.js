'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('tplink-smarthome-api');
const { fixture } = require('./helpers/tplink-device-fixture');

for (const id of ['hs210', 'hs220']) {
for (const [transport, protocol] of [['tcp', 'iot'], ['klap', 'smart'], ['aes', 'smart'], ['klap', 'iot'], ['aes', 'iot']]) {
  test(`${id.toUpperCase()} ${transport}/${protocol}: control, telemetry and restart retain the selected transport`, async () => {
    const authenticated = transport !== 'tcp';
    const smart = protocol === 'smart';
    const state = { on: false, brightness: 51, led: true };
    const sent = [];
    const clients = [];
    let reject = false;
    const sysInfo = () => ({ err_code: 0, deviceId: 'hs220-parent', model: id.toUpperCase() + '(US)',
      type: smart ? 'SMART.KASASWITCH' : 'IOT.SMARTPLUGSWITCH',
      alias: 'Dimmer', mac: '00:11:22:33:44:55', hw_ver: '3.26', sw_ver: '1.1.1',
      feature: 'TIM', relay_state: state.on ? 1 : 0, brightness: state.brightness, led_off: state.led ? 0 : 1 });
    class MockNetworkClient extends Client {
      constructor(options) { super(options); this.testOptions = options; clients.push(this); }
      async getSysInfo() { return sysInfo(); }
      getPlug(options) {
        const plug = super.getPlug(options);
        plug.send = async (payload, options) => {
          options = { ...plug.defaultSendOptions, ...options };
          if (typeof payload === 'string') payload = JSON.parse(payload);
          sent.push({ payload, transport: options.transport });
          assert.equal(options.transport, transport);
          if (reject) throw new Error('Test device rejected command');
          if (smart) {
            const execute = request => {
              let result = {};
              switch (request.method) {
                case 'component_nego': result = { component_list: [
                  { id: 'device', ver_code: 2 }, { id: 'brightness', ver_code: 1 },
                  { id: 'led', ver_code: 3 }, { id: 'smart_switch', ver_code: 1 },
                ] }; break;
                case 'get_device_info': result = { device_id: 'hs220-parent',
                  device_on: state.on, brightness: state.brightness }; break;
                case 'set_device_info':
                  if ('device_on' in request.params) state.on = request.params.device_on;
                  if ('brightness' in request.params) state.brightness = request.params.brightness;
                  break;
                case 'get_led_info': result = { led_rule: state.led ? 'always' : 'never', led_status: state.led }; break;
                case 'set_led_info': state.led = request.params.led_rule !== 'never'; break;
                default: assert.fail('Unexpected SMART command: ' + request.method);
              }
              return { method: request.method, error_code: 0, result };
            };
            return JSON.stringify(payload.method === 'multipleRequest'
              ? { error_code: 0, result: { responses: payload.params.requests.map(execute) } }
              : execute(payload));
          }
          const response = {};
          for (const [module, commands] of Object.entries(payload)) {
            response[module] = {};
            for (const [command, params] of Object.entries(commands)) {
              if (command === 'set_relay_state') state.on = params.state === 1;
              if (command === 'set_brightness') state.brightness = params.brightness;
              if (command === 'set_led_off') state.led = params.off === 0;
              response[module][command] = command === 'get_sysinfo' ? sysInfo() : { err_code: 0 };
            }
          }
          return JSON.stringify(response);
        };
        return plug;
      }
    }
    const f = fixture(id, { Client: MockNetworkClient });
    f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
    const d = f.makeDevice({ deviceId: 'hs220-parent', credentialSource: authenticated ? 'global' : undefined });
    d.getData = () => ({ id: 'existing-homey-id', transport, protocol });
    await d.onInit();
    assert.equal(d.client.testOptions.defaultSendOptions.transport, transport);
    assert.deepEqual(d.client.testOptions.credentials, authenticated ? f.globalCredentials : undefined);
    await d.onCapabilityOnoff(true);
    assert.equal(state.on, true);
    if (id === 'hs220') {
      await d.onCapabilityDim(0.7);
      assert.equal(state.brightness, 70);
    }
    await d.onCapabilityLedOnoff(false);
    assert.equal(state.led, false);
    assert.equal(await d.getLed(d.getSettings().settingIPAddress), false);
    state.on = false;
    state.brightness = 22;
    await d.getStatus();
    assert.equal(d.values.onoff, false);
    if (id === 'hs220') assert.equal(d.values.dim, 0.22, f.logs.join('\n'));
    await d.onInit();
    assert.equal(d.activeTransport, transport);
    assert.equal(f.timers.size, 1);
    assert.ok(sent.length > 0);
    reject = true;
    if (id === 'hs220') await assert.rejects(d.onCapabilityDim(0.8), /Test device rejected/);
    await assert.rejects(d.onCapabilityLedOnoff(true), /Test device rejected/);
    d.onDeleted();
    assert.equal(f.timers.size, 0);
  });
}

}

test('HS220 unmarked legacy pairing remains TCP when a global account exists', async () => {
  const f = fixture('hs220');
  f.globalCredentials = { username: 'owner@example.com', password: 'secret' };
  await f.device.onInit();
  assert.equal(f.device.activeTransport, 'tcp');
  assert.equal(f.device.client.options.credentials, undefined);
  assert.equal(f.device.client.options.defaultSendOptions.transport, 'tcp');
});

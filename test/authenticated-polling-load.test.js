'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { Client } = require('tplink-smarthome-api');
const { fixture } = require('./helpers/tplink-device-fixture');

function encryptedFixture(id) {
  const state = { handshakes: 0, requests: 0, statusReads: 0, on: true, brightness: 35, fail: false };
  class OfflineClient extends Client {
    createConnection(transport, ...args) {
      const connection = super.createConnection(transport, ...args);
      if (transport !== 'aes') {
        connection.send = async () => { throw new Error('Unexpected transport: ' + transport); };
        return connection;
      }
      // Keep the real RSA handshake, AES encryption, session expiry and request
      // handling. Replace only HTTP so no test can communicate with a device.
      connection.post = async (url, data) => {
        state.requests++;
        if (state.fail) throw new Error('TCP Timeout after 10000ms');
        const request = JSON.parse(data);
        let response;
        if (request.method === 'handshake') {
          state.handshakes++;
          const key = crypto.publicEncrypt({ key: request.params.key,
            padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.alloc(32, 7)).toString('base64');
          response = { error_code: 0, result: { key } };
        } else {
          const decipher = crypto.createDecipheriv('aes-128-cbc', connection.session.key, connection.session.iv);
          const plain = JSON.parse(Buffer.concat([
            decipher.update(Buffer.from(request.params.request, 'base64')), decipher.final(),
          ]).toString());
          function execute(command) {
            let result;
            switch (command.method) {
            case 'multipleRequest':
              result = { responses: command.params.requests.map(execute) };
              break;
            case 'login_device': result = { token: 'test-session' }; break;
            case 'get_device_info':
              state.statusReads++;
              result = { device_id: 'test-parent', model: id.toUpperCase(), type: 'SMART.KASASWITCH',
                nickname: Buffer.from('Test').toString('base64'), mac: '00:11:22:33:44:55',
                fw_ver: '1', hw_ver: '1', device_on: state.on, brightness: state.brightness };
              break;
            case 'component_nego': result = { component_list: [{ id: 'device', ver_code: 2 }] }; break;
            case 'get_connect_cloud_state': result = { status: 0 }; break;
            case 'control_child':
              assert.equal(command.params.device_id, 'child-1');
              if (command.params.requestData.method === 'set_device_info') {
                const params = command.params.requestData.params;
                if ('device_on' in params) state.on = params.device_on;
                if ('brightness' in params) state.brightness = params.brightness;
              } else {
                assert.equal(command.params.requestData.method, 'get_device_info');
                state.statusReads++;
              }
              result = { responseData: { error_code: 0, result: {
                device_id: 'child-1', device_on: state.on, brightness: state.brightness,
              } } };
              break;
            default: throw new Error('Unexpected command: ' + command.method);
            }
            return { method: command.method, error_code: 0, result };
          }
          const cipher = crypto.createCipheriv('aes-128-cbc', connection.session.key, connection.session.iv);
          const encrypted = Buffer.concat([
            cipher.update(JSON.stringify(execute(plain))), cipher.final(),
          ]).toString('base64');
          response = { error_code: 0, result: { response: encrypted } };
        }
        return { statusCode: 200, headers: { 'set-cookie': ['TP_SESSIONID=test; Path=/', 'TIMEOUT=86400; Path=/'] },
          body: JSON.stringify(response) };
      };
      return connection;
    }
  }
  const f = fixture(id, { Client: OfflineClient });
  f.globalCredentials = { username: 'test@example.invalid', password: 'test-password' };
  const device = f.makeDevice({ deviceId: 'test-parent', childId: 'child-1', channelType: 'light',
    credentialSource: 'global', pollingInterval: 2, dynamicIp: false });
  device.getData = () => ({ id: 'child-1', parentId: 'test-parent', childId: 'child-1', channelType: 'light' });
  device.getClass = () => 'light';
  return { f, device, state };
}

for (const id of ['ks240', 's500d']) {
  test(`${id}: repeated two-second polls reuse the real AES session and read fresh telemetry`, async t => {
    const { f, device, state } = encryptedFixture(id);
    t.after(() => device.onDeleted());
    await device.onInit();
    await device.getStatus();
    const warmupHandshakes = state.handshakes;
    const warmupRequests = state.requests;
    const warmupReads = state.statusReads;
    const plug = device.plug;
    assert.equal(warmupHandshakes, 2, 'One bootstrap session and one reusable Plug session');
    for (let i = 0; i < 30; i++) {
      f.now += 2000;
      state.on = i % 2 === 0;
      state.brightness = 20 + i;
      await device.getStatus();
      assert.equal(device.values.onoff, state.on, f.logs.join('\n'));
      assert.equal(device.values.dim, state.brightness / 100);
    }
    assert.equal(device.plug, plug);
    assert.equal(state.handshakes, warmupHandshakes, 'Polling must not generate RSA keys or log in again');
    assert.equal(state.statusReads - warmupReads, 30);
    assert.equal(state.requests - warmupRequests, 30);
    assert.equal(f.logs.some(line => line.startsWith('Status polling failed:')), false, f.logs.join('\n'));
  });

  test(`${id}: cached AES session refreshes on expiry, IP changes and credential replacement`, async t => {
    const { device, state } = encryptedFixture(id);
    t.after(() => device.onDeleted());
    await device.onInit();
    await device.getStatus();
    const original = device.plug;
    const beforeExpiry = state.handshakes;
    original.connections.aes.sessionExpiresAt = 0;
    await device.getStatus();
    assert.equal(device.plug, original);
    assert.equal(state.handshakes, beforeExpiry + 1);
    device.settings.settingIPAddress = '192.0.2.20';
    await device.getStatus();
    assert.notEqual(device.plug, original);
    assert.equal(device.plug.host, '192.0.2.20');
    const previous = device.plug;
    assert.equal(await device.refreshGlobalCredentials({ reason: 'test' }), true);
    await device.getStatus();
    assert.notEqual(device.plug, previous);
    assert.equal(device.plug.client, device.client);
    assert.equal(device.values.onoff, true);
  });

  test(`${id}: cached AES errors are reported and recovery still reads fresh state`, async t => {
    const { f, device, state } = encryptedFixture(id);
    t.after(() => device.onDeleted());
    await device.onInit();
    await device.getStatus();
    state.fail = true;
    await device.getStatus();
    assert.ok(f.logs.some(line => line.includes('Status polling failed:')));
    state.fail = false;
    state.on = false;
    await device.getStatus();
    assert.equal(device.values.onoff, false);
    assert.ok(f.logs.some(line => line === 'Device communication restored'));
  });
}

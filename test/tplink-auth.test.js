'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getEp10ClientOptions,
  getEp10Transport,
  getKs240SysInfo,
  getTpLinkClientOptions,
  getTpLinkDiscoveryClientOptions,
  isValidTpLinkTransport,
  normalizeTpLinkCredentials,
} = require('../lib/tplink-auth');

test('KS240 retries the observed AES handshake 1003 once over KLAP and retains its metadata', async () => {
  const calls = [];
  const sysInfo = { model: 'KS240(US)', mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 } };
  const client = {
    async getSysInfo(...args) {
      calls.push(args);
      if (calls.length === 1) {
        throw new Error('AesConnection(AES 192.168.10.103:80): handshake failed with error_code 1003');
      }
      return sysInfo;
    },
  };
  assert.equal(await getKs240SysInfo(client, '192.168.10.103'), sysInfo);
  assert.deepEqual(calls, [
    ['192.168.10.103'],
    ['192.168.10.103', undefined, { transport: 'klap' }],
  ]);
});

test('KS240 preserves successful AES and does not retry login, reachability, or KLAP errors', async () => {
  const sysInfo = { model: 'KS240' };
  assert.equal(await getKs240SysInfo({ getSysInfo: async () => sysInfo }, '192.0.2.1'), sysInfo);
  for (const message of [
    'AesConnection(AES 192.0.2.1:80): login_device failed with error_code 1003',
    'connect ECONNREFUSED 192.0.2.1:80',
    'KlapConnection(KLAP 192.0.2.1:80): authentication failed (challenge mismatch)',
  ]) {
    let calls = 0;
    const error = new Error(message);
    await assert.rejects(getKs240SysInfo({ getSysInfo: async () => { calls++; throw error; } }, '192.0.2.1'),
      caught => caught === error);
    assert.equal(calls, 1);
  }
});

test('KS240 reports the KLAP authentication failure instead of masking it with AES 1003', async () => {
  let calls = 0;
  const authError = new Error('KlapConnection(KLAP 192.168.10.103:80): authentication failed (challenge mismatch)');
  await assert.rejects(getKs240SysInfo({ getSysInfo: async () => {
    if (++calls === 1) throw new Error('AesConnection(AES 192.168.10.103:80): handshake failed with error_code 1003');
    throw authError;
  } }, '192.168.10.103'), error => error === authError);
  assert.equal(calls, 2);
});

test('uses the fixture-established SMART transport for every supported Homey model', () => {
  [
    ['KS225', 'klap'],
    ['S500D', 'aes'],
    ['KS240', 'aes'],
  ].forEach(([model, transport]) => {
    const options = getTpLinkClientOptions(model, {
      deviceUsername: ' account@example.com ',
      devicePassword: '  password with meaningful whitespace  ',
    });

    assert.deepEqual(options, {
      defaultSendOptions: { transport },
      credentials: {
        username: 'account@example.com',
        password: '  password with meaningful whitespace  ',
      },
    });
  });
});

test('does not create partial credentials and preserves a supplied password verbatim', () => {
  assert.deepEqual(
    normalizeTpLinkCredentials({
      deviceUsername: ' user@example.com ',
      devicePassword: '  literal password  ',
    }),
    { username: 'user@example.com', password: '  literal password  ' },
  );
  assert.deepEqual(getTpLinkClientOptions('KS225', { deviceUsername: 'user' }), {
    defaultSendOptions: { transport: 'klap' },
  });
});

test('EP10 uses a persisted pairing transport before the credential fallback', () => {
  assert.equal(
    getEp10Transport(
      { id: 'legacy-identity', transport: 'aes' },
      { deviceUsername: 'user@example.com', devicePassword: 'password' },
    ),
    'aes',
  );
  assert.equal(
    getEp10Transport(
      { id: 'legacy-identity', transport: 'invalid' },
      { deviceUsername: 'user@example.com', devicePassword: 'password' },
    ),
    'klap',
  );
  assert.equal(isValidTpLinkTransport('tcp'), true);
  assert.equal(isValidTpLinkTransport('klap'), true);
  assert.equal(isValidTpLinkTransport('aes'), true);
  assert.equal(isValidTpLinkTransport('udp'), false);
});

test('EP10 keeps pre-change devices on TCP until a complete credential pair exists', () => {
  assert.deepEqual(getEp10ClientOptions({ id: 'old-device' }, {}), {
    defaultSendOptions: { transport: 'tcp' },
  });
  assert.deepEqual(
    getEp10ClientOptions(
      { id: 'old-device' },
      { deviceUsername: 'account@example.com' },
    ),
    { defaultSendOptions: { transport: 'tcp' } },
  );
  assert.deepEqual(
    getEp10ClientOptions(
      { id: 'old-device' },
      {
        deviceUsername: ' account@example.com ',
        devicePassword: 'password with spaces ',
      },
    ),
    {
      defaultSendOptions: { transport: 'klap' },
      credentials: {
        username: 'account@example.com',
        password: 'password with spaces ',
      },
    },
  );
});

test('an unmarked EP10 stays on TCP when global credentials are added', () => {
  const globalCredentials = {
    username: 'account@example.com',
    password: 'password',
  };

  assert.deepEqual(
    getEp10ClientOptions({ id: 'old-device' }, {}, globalCredentials),
    { defaultSendOptions: { transport: 'tcp' } },
  );
  assert.deepEqual(
    getEp10ClientOptions(
      { id: 'old-device' },
      { credentialSource: 'global' },
      globalCredentials,
    ),
    {
      defaultSendOptions: { transport: 'klap' },
      credentials: globalCredentials,
    },
  );
  assert.deepEqual(
    getEp10ClientOptions(
      { id: 'old-device' },
      {
        credentialSource: 'override',
        deviceUsername: 'local@example.com',
        devicePassword: 'local password',
      },
      globalCredentials,
    ),
    {
      defaultSendOptions: { transport: 'klap' },
      credentials: {
        username: 'local@example.com',
        password: 'local password',
      },
    },
  );
});

test('discovery carries complete credentials without forcing an EP10 transport', () => {
  assert.deepEqual(
    getTpLinkDiscoveryClientOptions({
      deviceUsername: ' account@example.com ',
      devicePassword: 'password',
    }),
    {
      credentials: {
        username: 'account@example.com',
        password: 'password',
      },
    },
  );
  assert.deepEqual(
    getTpLinkDiscoveryClientOptions({ deviceUsername: 'account@example.com' }),
    {},
  );
});

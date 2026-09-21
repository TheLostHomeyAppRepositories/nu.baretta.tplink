'use strict';

const { isIP } = require('node:net');
const { Client } = require('tplink-smarthome-api');
const { getDeviceConnectionData } = require('./tplink-auth');
const { resolveDeviceCredentials, credentialsMatch } = require('./tplink-credentials');

// Never serialize sysInfo wholesale: it can contain owner hashes and device IDs.
function metadata(info = {}) {
  info = info || {};
  const scheme = info.mgt_encrypt_schm || {};
  const text = value => typeof value === 'string' ? value.replace(/[\r\n\x00-\x1f\x7f]/g, '').slice(0, 100) : null;
  const number = value => Number.isFinite(value) ? value : null;
  const flag = value => typeof value === 'boolean' || value === 0 || value === 1 ? value : null;
  return {
    model: text(info.model || info.device_model), type: text(info.type || info.mic_type || info.device_type),
    hardware: text(info.hw_ver), firmware: text(info.sw_ver),
    encrypt_type: ['KLAP', 'AES', 'XOR'].includes(scheme.encrypt_type) ? scheme.encrypt_type : null,
    http_port: number(scheme.http_port), lv: number(scheme.lv),
    new_klap: flag(scheme.new_klap), ANS: flag(scheme.ANS),
  };
}

function brightnessState(info = {}) {
  info = info || {};
  return {
    relay: info.relay_state === 0 || info.relay_state === 1 ? info.relay_state : null,
    brightness: Number.isFinite(info.brightness) ? info.brightness : null,
  };
}

// One bounded, credential-free discovery scan. It never authenticates or sends controls.
async function collect(entries, globalCredentials, {
  createClient = () => new Client({ logLevel: 'silent' }),
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const rows = entries.filter(entry => entry.driverId === 'hs220').map(({ device }) => {
    const settings = device.getSettings();
    const resolved = resolveDeviceCredentials(settings, globalCredentials);
    const connection = getDeviceConnectionData(device);
    return {
      host: isIP(settings.settingIPAddress || '') === 4 ? settings.settingIPAddress : null,
      account: !resolved.credentials ? 'none' : resolved.usesGlobalCredentials ? 'global' : 'device',
      matchesGlobalAccount: Boolean(resolved.credentials && globalCredentials && credentialsMatch(resolved.credentials, globalCredentials)),
      configuredTransport: ['tcp', 'klap', 'aes'].includes(device.activeTransport || connection.transport)
        ? device.activeTransport || connection.transport : null,
      lastSuccessfulPoll: device.hs220LastSuccessfulPoll || null,
      cachedStatus: { ...metadata(device.plug && device.plug.sysInfo), ...brightnessState(device.plug && device.plug.sysInfo) },
      discovery: null,
    };
  });
  const hosts = [...new Set(rows.map(row => row.host).filter(Boolean))];
  const report = { apiVersion: require('tplink-smarthome-api/package.json').version,
    appVersion: require('../app.json').version, devices: rows, scan: 'no-targets' };
  if (!hosts.length) return report;
  const client = createClient();
  return new Promise(resolve => {
    let finished = false;
    let timer;
    const finish = outcome => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      client.removeListener('plug-new', found);
      client.removeListener('plug-online', found);
      // Keep the error listener until stopDiscovery has closed its socket.
      try { client.stopDiscovery(); } catch (_) { outcome = 'discovery-error'; }
      finally { client.removeListener('error', failed); }
      report.scan = outcome;
      resolve(report);
    };
    const found = plug => {
      if (finished || !hosts.includes(plug.host) || !String(plug.model || '').toUpperCase().startsWith('HS220')) return;
      for (const row of rows) {
        if (row.host === plug.host) row.discovery = metadata(plug.sysInfo);
      }
    };
    // Report only a classification, never an arbitrary socket error/payload.
    const failed = () => finish('discovery-error');
    client.on('plug-new', found);
    client.on('plug-online', found);
    client.on('error', failed);
    timer = setTimer(() => finish('finished'), 5500);
    try {
      client.startDiscovery({ broadcast: hosts[0], devices: hosts.slice(1).map(host => ({ host })),
        deviceTypes: ['plug'], breakoutChildren: false, discoveryInterval: 1500, discoveryTimeout: 5000 });
    } catch (_) { finish('discovery-error'); }
  });
}

module.exports = { metadata, brightnessState, collect };

'use strict';

const Homey = require('homey');
const { createHash } = require('node:crypto');
const { Client } = require('tplink-smarthome-api');
const { getKs240SysInfo, getTpLinkClientOptions } = require('../../lib/tplink-auth');
const {
  getPairedCredentialSettings,
  getSafeErrorMessage,
  isAuthenticationError,
  resolvePairingCredentials,
} = require('../../lib/tplink-credentials');

const TPLINK_MODEL = 'KS240';

function identityTag(value) {
  return value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 10) : 'none';
}

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

function getChannelType(category) {
  return category === 'kasa.switch.outlet.sub-fan' ? 'fan' : 'light';
}

function getChannelName(parentName, category) {
  return `${parentName} ${getChannelType(category) === 'fan' ? 'Fan' : 'Light'}`;
}

function getDiscoveryParentName(plug, sysInfo) {
  return [
    sysInfo && sysInfo.alias,
    sysInfo && sysInfo.name,
    sysInfo && sysInfo.dev_name,
    plug && plug.alias,
    plug && plug.name,
    TPLINK_MODEL,
  ].find(value => typeof value === 'string' && value.length > 0);
}

function getPairingInput(value) {
  const input = value && typeof value === 'object' ? value : {};
  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const data = input.data && typeof input.data === 'object' ? input.data : {};
  return {
    ip:
      typeof input.ip === 'string'
        ? input.ip.trim()
        : typeof settings.settingIPAddress === 'string'
          ? settings.settingIPAddress.trim()
          : '',
    name: typeof input.name === 'string' ? input.name.trim() : '',
    parentId:
      input.parentId ?? settings.deviceId ?? data.parentId ?? '',
    childId: input.childId ?? settings.childId ?? data.childId ?? '',
    channelType: input.channelType ?? settings.channelType ?? data.channelType ?? '',
    deviceUsername:
      input.deviceUsername ?? input.username ?? settings.deviceUsername ?? '',
    devicePassword:
      input.devicePassword ?? input.password ?? settings.devicePassword ?? '',
  };
}

function getPairingClient(credentials) {
  const options = getTpLinkClientOptions(TPLINK_MODEL, {
    credentialSource: 'override',
    deviceUsername: credentials.username,
    devicePassword: credentials.password,
  });
  options.defaultSendOptions.timeout = 4000;
  options.logLevel = 'silent';
  return new Client(options);
}

function resolveCredentialsForPairing(driver, input) {
  if (
    driver.homey &&
    driver.homey.app &&
    typeof driver.homey.app.resolvePairingCredentials === 'function'
  ) {
    return driver.homey.app.resolvePairingCredentials(input);
  }
  return resolvePairingCredentials(input);
}

async function finalizeCredentialsForPairing(driver, resolution) {
  if (
    driver.homey &&
    driver.homey.app &&
    typeof driver.homey.app.finalizePairingCredentials === 'function'
  ) {
    return driver.homey.app.finalizePairingCredentials(resolution);
  }
  return {
    ...resolution,
    settings: getPairedCredentialSettings(resolution),
  };
}

function getChildrenFromResponse(response) {
  const childList = response && response.get_child_device_list;
  return childList && Array.isArray(childList.child_device_list)
    ? childList.child_device_list
    : [];
}

function makeChannels(input, parent) {
  const selectedChildren = input.childId
    ? parent.children.filter(child => child.device_id === input.childId)
    : parent.children;
  if (input.childId && selectedChildren.length === 0) {
    throw new Error(
      'The KS240 at the supplied address no longer exposes the channel selected during discovery.',
    );
  }

  return selectedChildren
    .filter(child => typeof child.device_id === 'string' && child.device_id.length > 0)
    .map(child => {
      const channelType = getChannelType(child.category);
      return {
        id: child.device_id,
        parentId: parent.deviceId,
        childId: child.device_id,
        channelType,
        name:
          input.name ||
          (typeof child.alias === 'string' && child.alias.length > 0
            ? child.alias
            : getChannelName(parent.name, child.category)),
      };
    });
}

async function validateTarget(input, credentials, log = () => {}) {
  if (!input.ip) {
    throw new Error('An IP address is required to pair a KS240.');
  }

  const client = getPairingClient(credentials);
  log(`KS240 pairing: validating ${input.ip}, selected parent=${identityTag(input.parentId)}, child=${identityTag(input.childId)}`);
  const sysInfo = await getKs240SysInfo(client, input.ip);
  const model = String(sysInfo.model || '').toUpperCase();
  const deviceId = sysInfo.deviceId || sysInfo.device_id;
  log(`KS240 pairing: authenticated ${input.ip}, model=${model}, parent=${identityTag(deviceId)}, transport=${sysInfo.mgt_encrypt_schm && sysInfo.mgt_encrypt_schm.encrypt_type || 'unknown'}`);
  if (!model.startsWith(TPLINK_MODEL) || !deviceId) {
    throw new Error('The supplied address is not an accessible KS240.');
  }
  if (input.parentId && input.parentId !== deviceId) {
    throw new Error(
      'The KS240 at the supplied address no longer matches the device selected during discovery.',
    );
  }

  const plug = client.getPlug({ host: input.ip, sysInfo });
  const responses = await plug.sendSmartRequests([
    { method: 'get_child_device_list' },
  ]);
  log(`KS240 pairing: validated ${getChildrenFromResponse(responses).length} child channels at ${input.ip}`);
  return {
    ip: input.ip,
    deviceId,
    name: getDiscoveryParentName(plug, sysInfo),
    children: getChildrenFromResponse(responses),
  };
}

class TPlinkKs240Driver extends Homey.Driver {
  async onPair(session) {
    const knownChildIds = new Set();
    let activeDiscovery = null;
    let pairingOpen = true;
    let requestVersion = 0;

    try {
      this.getDevices().forEach(device => {
        const childId = device.getData().id;
        if (typeof childId === 'string' && childId.length > 0) {
          knownChildIds.add(childId);
        }
      });
      this.log(`Existing ${TPLINK_MODEL} child IDs: ${knownChildIds.size}`);
    } catch (error) {
      this.log(`Unable to read existing ${TPLINK_MODEL} children: ${getSafeErrorMessage(error)}`);
    }

    const stopActiveDiscovery = () => {
      if (activeDiscovery) activeDiscovery.finish();
    };

    session.setHandler('get_credential_status', async () => {
      if (
        this.homey &&
        this.homey.app &&
        typeof this.homey.app.getCredentialStatus === 'function'
      ) {
        return this.homey.app.getCredentialStatus();
      }
      return { configured: false };
    });

    const discover = async input => {
      stopActiveDiscovery();
      const credentials = resolveCredentialsForPairing(this, input);
      this.log(`KS240 pairing: discovery started, credential source=${credentials.source}, target=${input.ip || 'LAN broadcast'}`);
      const client = getPairingClient(credentials.credentials);
      const discoveredDevices = [];
      const attemptedParents = new Set();
      const validations = new Set();
      let authenticationError;
      const discoveryOptions = {
        deviceTypes: ['plug'],
        discoveryInterval: 1500,
        discoveryTimeout: 5000,
        breakoutChildren: false,
        filterCallback: sysInfo => String(sysInfo.model || '').toUpperCase().startsWith(TPLINK_MODEL),
        ...(input.ip ? { devices: [{ host: input.ip }] } : {}),
      };

      return new Promise((resolve, reject) => {
        let acceptingCandidates = true;
        let timer = null;
        let finished = false;

        const finish = () => {
          if (finished) return;
          finished = true;
          acceptingCandidates = false;
          if (timer !== null) clearTimeout(timer);
          client.stopDiscovery();
          client.removeAllListeners();
          if (activeDiscovery && activeDiscovery.client === client) {
            activeDiscovery = null;
          }
          Promise.allSettled([...validations]).then(() => {
            this.log(`KS240 pairing: discovery finished, channels=${discoveredDevices.length}, authentication failure=${Boolean(authenticationError)}`);
            if (discoveredDevices.length === 0 && authenticationError) {
              reject(new Error(authenticationError));
            } else {
              resolve(discoveredDevices);
            }
          });
        };

        const validateParent = async plug => {
          try {
            const discoveryId = plug.deviceId;
            const sysInfo = await plug.getSysInfo();
            const model = String(sysInfo.model || plug.model || '').toUpperCase();
            const parentId = sysInfo.deviceId || sysInfo.device_id || plug.deviceId;
            this.log(`KS240 pairing: discovered ${plug.host}, model=${model}, discovery parent=${identityTag(discoveryId)}, authenticated parent=${identityTag(parentId)}, transport=${plug.defaultSendOptions && plug.defaultSendOptions.transport || 'unknown'}`);
            if (!model.startsWith(TPLINK_MODEL) || !parentId) return;

            const responses = await plug.sendSmartRequests([
              { method: 'get_child_device_list' },
            ]);
            const parent = {
              ip: plug.host,
              deviceId: parentId,
              name: getDiscoveryParentName(plug, sysInfo),
              children: getChildrenFromResponse(responses),
            };
            this.log(`KS240 pairing: ${parent.children.length} child channels returned by ${plug.host}`);
            makeChannels({}, parent).forEach(channel => {
              if (
                !knownChildIds.has(channel.id) &&
                !discoveredDevices.some(device => device.data.id === channel.id)
              ) {
                discoveredDevices.push({
                  ip: parent.ip,
                  name: channel.name,
                  data: {
                    id: channel.id,
                    parentId: channel.parentId,
                    childId: channel.childId,
                    channelType: channel.channelType,
                  },
                  settings: {
                    settingIPAddress: parent.ip,
                    dynamicIp: false,
                    deviceId: channel.parentId,
                    childId: channel.childId,
                    channelType: channel.channelType,
                    channelName: channel.name,
                  },
                });
              }
            });
          } catch (error) {
            if (isAuthenticationError(error)) {
              authenticationError = getSafeErrorMessage(error, credentials.credentials);
            }
            this.log(
              `Unable to validate a discovered ${TPLINK_MODEL}: ${getSafeErrorMessage(
                error,
                credentials.credentials,
              )}`,
            );
          }
        };

        const collectParent = plug => {
          if (!acceptingCandidates) return;
          if (!String(plug.model || '').toUpperCase().startsWith(TPLINK_MODEL)) return;
          const key = plug.deviceId || plug.host;
          if (!key || attemptedParents.has(key)) return;
          attemptedParents.add(key);
          const validation = validateParent(plug);
          validations.add(validation);
          void validation.finally(() => validations.delete(validation));
        };

        client.on('plug-new', collectParent);
        client.on('plug-online', collectParent);
        client.on('error', error => {
          if (acceptingCandidates) {
            this.log(
              `${TPLINK_MODEL} discovery error: ${getSafeErrorMessage(
                error,
                credentials.credentials,
              )}`,
            );
          }
        });

        activeDiscovery = { client, finish };
        try {
          client.startDiscovery(discoveryOptions);
          timer = setTimeout(finish, discoveryOptions.discoveryTimeout + 25);
        } catch (error) {
          this.log(
            `Unable to start ${TPLINK_MODEL} discovery: ${getSafeErrorMessage(
              error,
              credentials.credentials,
            )}`,
          );
          finish();
        }
      });
    };

    session.setHandler('discover', async data => {
      const version = ++requestVersion;
      const input = getPairingInput(Array.isArray(data) ? data[0] : data);
      let discoveredDevices;
      try {
        discoveredDevices = await discover(input);
      } catch (error) {
        if (!pairingOpen || version !== requestVersion) return [];
        throw error;
      }
      if (!pairingOpen || version !== requestVersion) return [];

      if (discoveredDevices.length > 0) {
        await session.emit('discovered_devices', discoveredDevices);
      } else {
        await session.emit('discovery_failed', { devicesFound: false });
      }
      return discoveredDevices;
    });

    session.setHandler('get_devices', async data => {
      const version = ++requestVersion;
      const inputs = (Array.isArray(data) ? data : [data]).map(getPairingInput);
      const devices = [];

      for (const input of inputs) {
        const pairingResolution = resolveCredentialsForPairing(this, input);
        let parent;
        try {
          parent = await validateTarget(input, pairingResolution.credentials, message => this.log(message));
        } catch (error) {
          this.log(`KS240 pairing: validation failed for ${input.ip}: ${getSafeErrorMessage(error, pairingResolution.credentials)}`);
          throw new Error(
            `Unable to validate the selected ${TPLINK_MODEL}: ${getSafeErrorMessage(
              error,
              pairingResolution.credentials,
            )}`,
          );
        }
        if (!pairingOpen || version !== requestVersion) return [];
        const channels = makeChannels(input, parent);
        if (channels.length === 0) {
          throw new Error('No pairable KS240 channels were found at the supplied address.');
        }
        const finalized = await finalizeCredentialsForPairing(this, pairingResolution);

        channels.forEach(channel => {
          if (knownChildIds.has(channel.id)) return;
          devices.push({
            data: {
              id: channel.id || guid(),
              parentId: channel.parentId,
              childId: channel.childId,
              channelType: channel.channelType,
            },
            name: channel.name,
            settings: {
              settingIPAddress: parent.ip,
              dynamicIp: false,
              deviceId: channel.parentId,
              childId: channel.childId,
              channelType: channel.channelType,
              channelName: channel.name,
              ...finalized.settings,
            },
          });
        });
      }

      if (devices.length === 0) {
        throw new Error('All selected KS240 channels are already paired.');
      }
      session.setHandler('list_devices', async () => devices);
      this.log(`KS240 pairing: ${devices.length} validated channels ready to add`);
      await session.emit('continue', null);
      return devices;
    });

    session.setHandler('cancel', () => {
      pairingOpen = false;
      requestVersion += 1;
      stopActiveDiscovery();
    });

    session.setHandler('disconnect', () => {
      pairingOpen = false;
      requestVersion += 1;
      stopActiveDiscovery();
    });
  }
}

module.exports = TPlinkKs240Driver;

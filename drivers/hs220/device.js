'use strict';
const Homey = require('homey');
const { getRecovery } = require('../../lib/tplink-recovery');
const { Client } = require('tplink-smarthome-api');

const {
    getEp10ClientOptions,
    getDeviceConnectionData,
    getEp10Transport,
    getTpLinkDiscoveryClientOptions,
    isValidTpLinkTransport
} = require('../../lib/tplink-auth');
const {
    CREDENTIAL_SOURCES,
    resolveDeviceCredentials,
    getManualCredentialTransition,
    getSafeErrorMessage: redactErrorMessage
} = require('../../lib/tplink-credentials');

const CREDENTIAL_VALIDATION_TIMEOUT = 4000;

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
}

var util = require('util')

const TPlinkModel = 'HS220';

function getGlobalCredentials(device) {
    const app = device && device.homey && device.homey.app;
    return app && typeof app.getGlobalCredentials === 'function'
        ? app.getGlobalCredentials()
        : null;
}

function createClientFromSettings(device, data, settings, activeTransport, { timeout } = {}) {
    const connectionData = { ...data, transport: isValidTpLinkTransport(data.transport) ? data.transport : activeTransport };
    const options = getEp10ClientOptions(connectionData, settings, getGlobalCredentials(device));

    if (timeout) options.defaultSendOptions.timeout = timeout;

    return new Client({ ...options, logLevel: 'silent' });
}

function getSafeErrorMessage(error, settings = {}, globalCredentials = null) {
    return redactErrorMessage(error, settings, globalCredentials);
}

function getDiscoveredTransport(plug) {
    const transport = plug && plug.defaultSendOptions ? plug.defaultSendOptions.transport : undefined;
    return isValidTpLinkTransport(transport) ? transport : undefined;
}


class TPlinkPlugDevice extends Homey.Device {

    async onInit() {
        getRecovery(this).initialize();
        this.log('device init');
        let device = this;

        // console.dir(this.getSettings()); // for debugging
        // console.dir(getDeviceConnectionData(this)); // for debugging
        let settings = this.getSettings();
        let id = getDeviceConnectionData(this).id;
        let TPlinkModel = getDriverName().toUpperCase();
        this.log('id: ', id);
        this.log('name: ', this.getName());
        this.log('class: ', this.getClass());
        this.log('settings IP address: ', settings["settingIPAddress"])
        this.log('Driver ID: ', TPlinkModel);

        // in case the device was not paired with a version including the dynamicIp setting, set it to false
        if ((settings["dynamicIp"] != undefined) && (typeof (settings["dynamicIp"]) === 'boolean')) {
            this.log("dynamicIp is defined: " + settings["dynamicIp"])
        } else {
            this.setSettings({
                dynamicIp: false
            }).catch(this.error);
        }

        this.activeTransport = getEp10Transport(getDeviceConnectionData(this), settings, getGlobalCredentials(this));
        this.client = createClientFromSettings(this, getDeviceConnectionData(this), settings, this.activeTransport);
        this.log('HS220 transport configured: ' + this.activeTransport);

        this.log('settings totalOffset: ', settings["totalOffset"])



        this.oldpowerState = "";
        this.oldtotalState = 0;
        this.totalOffset = settings["totalOffset"] || 0;
        this.oldvoltageState = 0;
        this.oldcurrentState = 0;
        this.unreachableCount = 0;
        this.discoverCount = 0;
        this.oldRelayState = this.getCapabilityValue('onoff') ? 1 : 0;
        let interval;
        // Ensures that the pollingInterval is properly set during initialization
        if (typeof settings["pollingInterval"] === 'number') {
            this.log("Polling interval is set: " + settings["pollingInterval"] + " seconds");
            interval = parseInt(settings["pollingInterval"], 10); // Safely parse it to an integer
        } else {
            // Default value set if pollingInterval is not defined or is incorrectly set
            try {
                await this.setSettings({ pollingInterval: 10 }); // Use await to ensure settings are applied
                this.log("Polling interval was undefined, set to default: 10 seconds");
                interval = 10; // Set interval to default after ensuring settings are applied
            } catch (error) {
                this.error('Failed to set default polling interval:', error);
                interval = 10; // Optionally set a default even in case of error to ensure continuity
            }
        }

        this.pollDevice(interval);

        this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));

        this.registerCapabilityListener('ledonoff', this.onCapabilityLedOnoff.bind(this));

        this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));

    } // end onInit

    onAdded() {
        let id = getDeviceConnectionData(this).id;
        this.log("Device added: " + id);
        let settings = this.getSettings();
    }

    // this method is called when the Device is deleted
    onDeleted() {
        getRecovery(this).destroy();
        let id = getDeviceConnectionData(this).id;
        this.log("Device deleted: " + id);
        clearInterval(this.pollingInterval);
        clearTimeout(this.pollStartTimer);
    }

    // this method is called when the Device has requested a state change (turned on or off)
async onCapabilityOnoff(value, opts) {
    try {
        this.log("Capability called: onoff value:", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        if (value) {
            await this.powerOn(device);
        } else {
            await this.powerOff(device);
        }
        return null;
    } catch (err) {
        this.error('Error in onCapabilityOnoff:' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
        throw err;
    }
}

async onCapabilityLedOnoff(value, opts) {
    try {
        this.log("Capability called: LED onoff value:", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        if (value) {
            await this.ledOn(device);
        } else {
            await this.ledOff(device);
        }
        return null;
    } catch (err) {
        this.error('Error in onCapabilityLedOnoff:' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
        throw err;
    }
}

async onSettings({ oldSettings = {}, newSettings = {}, changedKeys = [] }) {
        await getRecovery(this).settingsChanged(changedKeys);
        let candidateSettings = {};
        try {
            const currentSettings = this.getSettings() || {};
            candidateSettings = { ...currentSettings, ...oldSettings, ...newSettings };
            const changed = Array.isArray(changedKeys) ? changedKeys : [];
            const credentialsChanged = changed.includes('deviceUsername') || changed.includes('devicePassword');
            let credentialConnectionUpdated = false;

            if (credentialsChanged) {
                const transition = this.getManualCredentialTransition(candidateSettings);
                const data = getDeviceConnectionData(this);
                if (!transition.credentials && data.transport !== 'tcp') {
                    throw new Error(
                        'Complete global TP-Link account credentials are required before clearing credentials for authenticated HS220 firmware.'
                    );
                }

                const effectiveSettings = { ...candidateSettings, ...transition.settings };
                const transport = getEp10Transport(data, effectiveSettings, getGlobalCredentials(this));
                const validated = await this.validateCredentialTransition(
                    effectiveSettings,
                    transport
                );
                await this.setSettings(transition.settings);
                this.activeTransport = transport;
                this.client = validated.client;
                this.plug = validated.plug;
                credentialConnectionUpdated = true;
                candidateSettings = effectiveSettings;
                this.log('TP-Link account credential source updated: ' + transition.source);
            }

            for (const key of changed) {
                switch (key) {
                    case 'settingIPAddress':
                        this.log('IP address changed to ' + candidateSettings.settingIPAddress);
                        // Re-initialize connection if IP address changes
                        if (!candidateSettings.dynamicIp && !credentialConnectionUpdated) { // Only reconnect if dynamic IP is not used
                            await this.reinitializeConnection(candidateSettings.settingIPAddress, {
                                settings: candidateSettings
                            });
                        }
                        break;
                    case 'pollingInterval':
                        const interval = parseInt(candidateSettings.pollingInterval, 10) || 10; // Ensure there's a fallback interval
                        this.log('Polling interval changed to ' + interval + ' seconds');
                        clearInterval(this.pollingInterval);
                        clearTimeout(this.pollStartTimer);
                        this.pollDevice(interval); // Start polling with the defined interval
                        break;
                    case 'dynamicIp':
                        this.log('Dynamic IP setting changed to ' + candidateSettings.dynamicIp);
                        break;
                    case 'deviceUsername':
                    case 'devicePassword':
                        break;
                    default:
                        this.log('Unhandled setting change detected for key:', key);
                        break;
                }
            }
        } catch (error) {
            const message = getSafeErrorMessage(error, candidateSettings, getGlobalCredentials(this));
            this.error('Failed to handle settings change: ' + message);
            throw new Error('Failed to update settings: ' + message);
        }
    }

    async reinitializeConnection(ipAddress, {
        settings = this.getSettings(),
        throwOnFailure = false
    } = {}) {
        // Implement the logic to reinitialize the connection
        // For example, update the plug instance
        try {
            const sysInfo = await this.client.getSysInfo(ipAddress);
            this.plug = this.client.getPlug({ host: ipAddress, sysInfo });
            this.log('Reinitialized connection to', ipAddress);
        } catch (err) {
            const message = getSafeErrorMessage(err, settings, getGlobalCredentials(this));
            this.error('Error reinitializing connection: ' + message);
            if (throwOnFailure) throw new Error(message);
        }
    }

async powerOn(device) {
    try {
        this.log('Turning device on ' + device);
        const sysInfo = await this.client.getSysInfo(device);
        this.plug = this.client.getPlug({ host: device, sysInfo });
        await this.plug.setPowerState(true);
    } catch (err) {
        this.error('Error turning device on:' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
        throw err;
    }
}


async powerOff(device) {
    try {
        this.log('Turning device off ' + device);
        const sysInfo = await this.client.getSysInfo(device);
        this.plug = this.client.getPlug({ host: device, sysInfo });
        await this.plug.setPowerState(false);
    } catch (err) {
        this.error('Error turning device off:' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
        throw err;
    }
}

    async setBrightness(device, brightness) {
        try {
            this.log('Setting brightness for device ' + device + ' to ' + brightness);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.dimmer.setBrightness(brightness);
            if (this.plug.shouldUseSmartMethods()) {
                // SMART brightness changes do not switch an off relay back on.
                if (brightness > 0 && this.plug.sysInfo.relay_state !== 1) {
                    await this.plug.setPowerState(true);
                }
                await this.setCapabilityValue('onoff', brightness > 0);
                await this.setCapabilityValue('dim', brightness / 100);
            }
        } catch (err) {
            this.log('Error setting brightness: ' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
            throw err;
        }
    }

async getPower(device) {
    try {
        const sysInfo = await this.client.getSysInfo(device);
        this.plug = this.client.getPlug({ host: device, sysInfo });
        const plugInfo = await this.plug.getSysInfo();
        const isOn = plugInfo.relay_state === 1;
        this.log(`State - relay state is ${isOn ? 'on' : 'off'}`);
        return isOn;
    } catch (err) {
        this.log("Caught error in getPower function: " + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
        return false; // or throw err;
    }
}

async getLed(device) {
    try {
        const sysInfo = await this.client.getSysInfo(device);
        this.plug = this.client.getPlug({ host: device, sysInfo });
        const isLedOn = await this.plug.getLedState();
        this.log(`LED is ${isLedOn ? 'on' : 'off'}`);
        return isLedOn;
    } catch (err) {
        this.error('Caught error in getLed function:' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
        return false;
    }
}

    async ledOn(device) {
        try {
            this.log('Turning LED on for device ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(true);
            await this.setCapabilityValue('ledonoff', true);
        } catch (err) {
            this.log('Error turning LED on: ' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
            throw err;
        }
    }

    async ledOff(device) {
        try {
            this.log('Turning LED off for device ' + device);
            const sysInfo = await this.client.getSysInfo(device);
            this.plug = this.client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(false);
            await this.setCapabilityValue('ledonoff', false);
        } catch (err) {
            this.log('Error turning LED off: ' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
            throw err;
        }
    }

    async onCapabilityDim(value, opts) {
        this.log("Capability called: dim value: ", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];

        try {
            // Assuming the value is between 0.0 and 1.0, and converting it to a percentage
            await this.setBrightness(device, value * 100);
        } catch (err) {
            this.log('Error setting brightness:' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
            throw err;
        }
    }

    async getStatus() {
        const recovery = getRecovery(this);
        const poll = recovery.beginPoll();
        if (!poll) return;

        let settings = this.getSettings();
        let device = settings.settingIPAddress;
        let TPlinkModel = getDriverName().toUpperCase();

        try {
            if (!this.plug || this.plug.client !== this.client || this.plug.host !== device) {
                const sysInfo = await this.client.getSysInfo(device);
                if (!recovery.isCurrent(poll)) return;
                this.plug = this.client.getPlug({
                    host: device, sysInfo: sysInfo
                });
            }

            const data = this.activeTransport === 'klap' || this.activeTransport === 'aes'
                ? { sysInfo: await this.plug.getSysInfo() }
                : await this.plug.getInfo();
            if (!recovery.responded(poll)) return;
                //this.log("DeviceID: " + settings["deviceId"]);
                //this.log("GetStatus data.sysInfo.deviceId: " + data.sysInfo.deviceId);

                if (settings["deviceId"] === undefined) {
                    await this.setSettings({
                        deviceId: data.sysInfo.deviceId
                    }).catch(this.error);
                    this.log("DeviceId added: " + settings["deviceId"])
                }

                if (!["HS100", "HS200", "HS220", "KS230", "KP405", "HS103", "EP10", "ES20M", "HS210"].includes(TPlinkModel)) {

                    this.oldpowerState = this.getCapabilityValue('measure_power');
                    this.oldtotalState = this.getCapabilityValue('meter_power');
                    this.oldvoltageState = this.getCapabilityValue('measure_voltage');
                    this.oldcurrentState = this.getCapabilityValue('measure_current');
                    this.oldRelayState = this.getCapabilityValue('onoff') ? 1 : 0;

                    var total = data.emeter.realtime.total;
                    var corrected_total = total - this.totalOffset;
                }

                const relayState = data.sysInfo.relay_state;
                const powerState = relayState === 1;
                const currentPowerState = this.getCapabilityValue('onoff');

                if (this.oldRelayState !== relayState || currentPowerState !== powerState) {
                    this.log(`Plug poll - relay is ${powerState ? 'on' : 'off'} `);
                    await this.setCapabilityValue('onoff', powerState);
                    this.oldRelayState = relayState; // Update the this.oldRelayState to the new value
                }

                // update realtime data only in case it changed
                if (!["HS100", "HS200", "HS220", "KS230", "KP405", "HS103", "EP10", "ES20M", "HS210"].includes(TPlinkModel)) {

                    if (this.oldtotalState != corrected_total) {
                        this.log("Total - Offset: " + corrected_total);
                        await this.setCapabilityValue('meter_power', corrected_total);
                    }

                    if (this.oldpowerState != data.emeter.realtime.power) {
                        this.log('Power changed: ' + data.emeter.realtime.power);
                        await this.setCapabilityValue('measure_power', data.emeter.realtime.power);
                    }
                    if (this.oldvoltageState != data.emeter.realtime.voltage) {
                        this.log('Voltage changed: ' + data.emeter.realtime.voltage);
                        await this.setCapabilityValue('measure_voltage', data.emeter.realtime.voltage);
                    }
                    if (this.oldcurrentState != data.emeter.realtime.current) {
                        this.log('Current changed: ' + data.emeter.realtime.current);
                        await this.setCapabilityValue('measure_current', data.emeter.realtime.current);
                    }
                }

                // check if model support dimming
                if (TPlinkModel === "HS220" || TPlinkModel === "ES20M" || TPlinkModel === "KS230") {
                    try {
                        // The device retains its last brightness while off; Homey shows the output level.
                        const brightness = powerState ? this.plug.dimmer.brightness : 0;
                        recovery.logChanged('brightness', brightness, 'State - brightness level: ' + brightness);
                        // Update Homey device state for brightness
                        if (Number.isFinite(brightness) && this.getCapabilityValue('dim') !== brightness / 100) {
                            await this.setCapabilityValue('dim', brightness / 100);
                        }
                    } catch (err) {
                        this.log('Error getting brightness: ' + ' ' + getSafeErrorMessage(err, this.getSettings(), getGlobalCredentials(this)));
                    }
                }

            await recovery.succeeded(poll);
        } catch (error) {
            await recovery.failed(poll, error);
        } finally {
            recovery.endPoll(poll);
        }
    }

pollDevice(interval) {
    clearInterval(this.pollingInterval);
    clearTimeout(this.pollStartTimer);
    // Stagger the first poll within the interval so devices initialized
    // together do not all open connections in the same tick.
    const pollStatus = async () => {
        try {
            await this.getStatus();
        } catch (err) {
            this.log("Error during polling: " + err.message);
            // Optionally, handle reconnection or retry logic here
        }
    };
    this.pollStartTimer = setTimeout(() => {
        this.pollStartTimer = null;
        this.pollingInterval = setInterval(pollStatus, 1000 * interval);
        void pollStatus();
    }, Math.floor(Math.random() * 1000 * interval));
}


    stopActiveDiscovery() {
        getRecovery(this).cancel();
    }

    isConfiguredForGlobalCredentials() {
        if (getDeviceConnectionData(this).transport === 'tcp') return false;
        return this.getSettings().credentialSource !== CREDENTIAL_SOURCES.OVERRIDE;
    }

    async refreshGlobalCredentials({ reason } = {}) {
        if (!this.isConfiguredForGlobalCredentials()) return false;

        this.stopActiveDiscovery();
        const refreshGeneration = (this.globalCredentialRefreshGeneration || 0) + 1;
        this.globalCredentialRefreshGeneration = refreshGeneration;
        const settings = this.getSettings();
        const transport = getEp10Transport(getDeviceConnectionData(this), settings, getGlobalCredentials(this));
        const client = createClientFromSettings(this, getDeviceConnectionData(this), settings, transport);
        this.activeTransport = transport;
        this.client = client;
        this.plug = null;

        try {
            const sysInfo = await client.getSysInfo(settings.settingIPAddress);
            if (
                refreshGeneration !== this.globalCredentialRefreshGeneration ||
                client !== this.client
            ) return false;

            this.plug = client.getPlug({ host: settings.settingIPAddress, sysInfo });
            this.log('Refreshed global TP-Link credentials' + (reason ? ': ' + reason : ''));
            return true;
        } catch (error) {
            if (
                refreshGeneration === this.globalCredentialRefreshGeneration &&
                client === this.client
            ) {
                this.log('Unable to refresh global TP-Link credentials: ' + getSafeErrorMessage(error, settings, getGlobalCredentials(this)));
            }
            return false;
        }
    }

    getManualCredentialTransition(settings) {
        const app = this.homey && this.homey.app;
        if (app && typeof app.getManualDeviceCredentialTransition === 'function') {
            return app.getManualDeviceCredentialTransition(settings);
        }
        return getManualCredentialTransition(settings);
    }

    async validateCredentialTransition(settings, transport) {
        if (!settings.settingIPAddress) {
            throw new Error('A device IP address is required to validate TP-Link account credentials.');
        }

        const client = createClientFromSettings(
            this,
            getDeviceConnectionData(this),
            settings,
            transport,
            { timeout: CREDENTIAL_VALIDATION_TIMEOUT }
        );
        try {
            const sysInfo = await client.getSysInfo(settings.settingIPAddress);
            return {
                client,
                plug: client.getPlug({ host: settings.settingIPAddress, sysInfo })
            };
        } catch (error) {
            throw new Error(
                'Unable to validate TP-Link account credentials for this device: ' +
                getSafeErrorMessage(error, settings, getGlobalCredentials(this))
            );
        }
    }

    canRecoverTransport(error) {
        return this.activeTransport === 'tcp' &&
            (error && error.code === 'ECONNREFUSED' && error.port === 9999 ||
             /ECONNREFUSED[^\n]*:9999/.test(error && error.message || ''));
    }

    async updateInMemoryTransport(transport, settings, protocol, current = () => true) {
        if (!isValidTpLinkTransport(transport) || !current()) return;
        const profile = { host: settings.settingIPAddress, transport, protocol };
        const previous = this.getStoreValue('tplinkConnection');
        if (!previous || previous.host !== profile.host || previous.transport !== transport || previous.protocol !== protocol) {
            await this.setStoreValue('tplinkConnection', profile);
        }
        if (!current()) return;
        this.activeTransport = transport;
        this.client = createClientFromSettings(this, getDeviceConnectionData(this), settings, transport);
        this.log('Transport confirmed by rediscovery: ' + transport + ', protocol=' + protocol);
    }

    async discover({ transportRecovery = false } = {}) {
        return getRecovery(this).discover({
            createClient: settings => new Client({ ...getTpLinkDiscoveryClientOptions(settings, getGlobalCredentials(this)), defaultSendOptions: { timeout: 4000 }, logLevel: 'silent' }),
            type: 'plug',
            allowFixedIp: transportRecovery,
            resolveCandidate: async (plug, settings) => {
                if (!String(plug.model || '').toUpperCase().startsWith(TPlinkModel)) return null;
                const discoveryId = plug.deviceId;
                const options = getTpLinkDiscoveryClientOptions(settings, getGlobalCredentials(this));
                const transport = getDiscoveredTransport(plug);
                const resolved = resolveDeviceCredentials(settings, getGlobalCredentials(this));
                const account = !resolved.credentials ? 'none' : resolved.usesGlobalCredentials ? 'global' : 'device';
                const advertisedVersion = plug.sysInfo && plug.sysInfo.mgt_encrypt_schm && plug.sysInfo.mgt_encrypt_schm.lv;
                const loginVersion = Number.isInteger(advertisedVersion) ? advertisedVersion : 'unknown';
                const diagnostic = `transport=${transport}, login version=${loginVersion}, account=${account}`;
                getRecovery(this).logChanged('transportCandidate', diagnostic, 'Transport candidate: ' + diagnostic);
                if (transport !== 'tcp' && !options.credentials) {
                    throw new Error('Authenticated firmware found; save the TP-Link owner account in app settings.');
                }
                const sysInfo = await plug.getSysInfo();
                const model = sysInfo.model || plug.model;
                if (!String(model || '').toUpperCase().startsWith(TPlinkModel)) return null;
                const protocol = String(sysInfo.type || sysInfo.mic_type || '').startsWith('SMART.') ? 'smart' : 'iot';
                return {
                    deviceId: discoveryId === settings.deviceId ? discoveryId : sysInfo.deviceId || sysInfo.device_id || plug.deviceId,
                    host: plug.host,
                    afterSave: current => this.updateInMemoryTransport(transport, { ...settings, settingIPAddress: plug.host }, protocol, current),
                };
            },
        });
    }

}

module.exports = TPlinkPlugDevice;

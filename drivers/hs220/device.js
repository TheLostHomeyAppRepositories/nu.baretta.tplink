'use strict';
const Homey = require('homey');
const { Client } = require('tplink-smarthome-api');
const client = new Client();

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
}

var oldpowerState = "";
var oldtotalState = 0;
var totalOffset = 0;
var oldvoltageState = 0;
var oldcurrentState = 0;
var unreachableCount = 0;
var discoverCount = 0;
var util = require('util')

class TPlinkPlugDevice extends Homey.Device {

    async onInit() {
        this.log('device init');
        let device = this;
        var interval = 10;

        // console.dir(this.getSettings()); // for debugging
        // console.dir(this.getData()); // for debugging
        let settings = this.getSettings();
        let id = this.getData().id;
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

        this.log('settings totalOffset: ', settings["totalOffset"])
        totalOffset = settings["totalOffset"];

        this.pollDevice(interval);

        this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));

        this.registerCapabilityListener('ledonoff', this.onCapabilityLedOnoff.bind(this));

        this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));

        // register flow card actions

        this.homey.flow.getActionCard('ledOn').registerRunListener(async (args, state) => {
            return args.device.ledOn(args.device.getSettings().settingIPAddress);
        });

        this.homey.flow.getActionCard('ledOff').registerRunListener(async (args, state) => {
            return args.device.ledOff(args.device.getSettings().settingIPAddress);
        });

        let setBrightnessAction = this.homey.flow.getActionCard('set_brightness');
        setBrightnessAction.registerRunListener(async (args, state) => {
            const { device, brightness } = args;
            try {
                await device.setBrightness(device.getSettings().settingIPAddress, brightness);
                return true; // Action was successful
            } catch (err) {
                this.log(err);
                return false; // Action failed
            }
        });


    } // end onInit

    onAdded() {
        let id = this.getData().id;
        this.log("Device added: " + id);
        let settings = this.getSettings();
        var interval = 10;

        //        this.pollDevice(interval);
    }

    // this method is called when the Device is deleted
    onDeleted() {
        let id = this.getData().id;
        this.log("Device deleted: " + id);
        clearInterval(this.pollingInterval);
    }

    // this method is called when the Device has requested a state change (turned on or off)
    async onCapabilityOnoff(value, opts, callback) {
        // ... set value to real device
        this.log("Capability called: onoff value: ", value);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        if (value) {
            await this.powerOn(device);
        } else {
            await this.powerOff(device);
        }
        // Then, emit a callback ( err, result )
        return (null);
    }

    async onCapabilityLedOnoff(value, opts, callback) {
        this.log("Capability called: LED onoff value: ", value);
        this.log("Capability called: opts", opts);
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        if (value) {
            await this.ledOn(device);
        } else {
            await this.ledOff(device);
        }
        // Then, emit a callback ( err, result )
        return (null);
    }

    // start functions
    onSettings(settings, newSettingsObj, changedKeysArr, callback) {
        try {
            for (var i = 0; i < changedKeysArr.length; i++) {
                this.log("Key: " + changedKeysArr[i]);
                switch (changedKeysArr[i]) {
                    case 'settingIPAddress':
                        this.log('IP address changed to ' + newSettingsObj.settingIPAddress);
                        settings.settingIPAddress = newSettingsObj.settingIPAddress;
                        break;

                    case 'dynamicIp':
                        this.log('DynamicIp option changed to ' + newSettingsObj.dynamicIp);
                        settings.dynamicIp = newSettingsObj.dynamicIp;
                        break;

                    default:
                        this.log("Key not matched: " + i);
                        break;
                }
            }
            return true;
        } catch (error) {
            return "error";
        }
    }

    async powerOn(device) {
        try {
            this.log('Turning device on ' + device);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setPowerState(true);
        } catch (err) {
            this.log('Error turning device on: ', err.message);
            // Handle the error appropriately
        }
    }


    async powerOff(device) {
        try {
            this.log('Turning device off ' + device);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setPowerState(false);
        } catch (err) {
            this.log('Error turning device off: ', err.message);
            // Handle the error appropriately
        }
    }

    async setBrightness(device, brightness) {
        try {
            this.log('Setting brightness for device ' + device + ' to ' + brightness);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.dimmer.setBrightness(brightness);
        } catch (err) {
            this.log('Error setting brightness: ', err.message);
        }
    }

getPower(device) {
    return client.getSysInfo(device)  // Ensure this function returns a promise
        .then(sysInfo => {
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            return this.plug.getSysInfo();
        })
        .then(sysInfo => {
            if (sysInfo.relay_state === 1) {
                this.log('Relay state is on');
                return true;  // Return true when the relay is on
            } else {
                this.log('Relay state is off');
                return false; // Return false when the relay is off
            }
        })
        .catch(err => {
            this.log("Caught error in getPower function: " + err.message);
            throw err;  // Re-throw or handle the error appropriately
        });
}

getLed(device) {
    return client.getSysInfo(device)  // Ensure this function returns a promise
        .then(sysInfo => {
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            return this.plug.getSysInfo();
        })
        .then(sysInfo => {
            if (sysInfo.led_off === 0) {
                this.log('LED on');
                return true;  // Return true if LED is on
            } else {
                this.log('LED off');
                return false; // Return false if LED is off
            }
        })
        .catch(err => {
            this.log("Caught error in getLed function: " + err.message);
            throw err;  // Re-throw or handle the error appropriately
        });
}

    async ledOn(device) {
        try {
            this.log('Turning LED on for device ' + device);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(true);
            await this.setCapabilityValue('ledonoff', true);
        } catch (err) {
            this.log('Error turning LED on: ', err.message);
            // Handle the error appropriately
        }
    }

    async ledOff(device) {
        try {
            this.log('Turning LED off for device ' + device);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(false);
            await this.setCapabilityValue('ledonoff', false);
        } catch (err) {
            this.log('Error turning LED off: ', err.message);
            // Handle the error appropriately
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
            this.log('Error setting brightness:', err.message);
            // You can also perform additional error handling here if necessary
        }
    }

    async getStatus() {
        let settings = this.getSettings();
        let device = settings.settingIPAddress;
        let TPlinkModel = getDriverName().toUpperCase();
        this.log("getStatus device: " + device);

        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({
                host: device, sysInfo: sysInfo
            });

            this.plug.getInfo().catch((err) => {
                this.log("Error getting plug info: " + err.message);
            }).then((data) => {
                //this.log("DeviceID: " + settings["deviceId"]);
                //this.log("GetStatus data.sysInfo.deviceId: " + data.sysInfo.deviceId);

                if (settings["deviceId"] === undefined) {
                    this.setSettings({
                        deviceId: data.sysInfo.deviceId
                    }).catch(this.error);
                    this.log("DeviceId added: " + settings["deviceId"])
                }

                if (TPlinkModel != "HS100" && TPlinkModel != "HS200" && TPlinkModel != "HS220" &&
                    TPlinkModel != "KS230" && TPlinkModel != "KP405" && TPlinkModel != "HS103" &&
                    TPlinkModel != "EP10" && TPlinkModel != "ES20M" && TPlinkModel != "HS210") {

                    oldpowerState = this.getCapabilityValue('measure_power');
                    oldtotalState = this.getCapabilityValue('meter_power');
                    oldvoltageState = this.getCapabilityValue('measure_voltage');
                    oldcurrentState = this.getCapabilityValue('measure_current');

                    var total = data.emeter.realtime.total;
                    var corrected_total = total - totalOffset;
                }

                if (data.sysInfo.relay_state === 1) {
                    this.log('Relay state is on ');
                    this.setCapabilityValue('onoff', true)
                        .catch(this.error);
                } else {
                    this.log('Relay state is off ');
                    this.setCapabilityValue('onoff', false)
                        .catch(this.error);
                }

                // update realtime data only in case it changed
                if (TPlinkModel != "HS100" && TPlinkModel != "HS200" && TPlinkModel != "HS220" &&
                    TPlinkModel != "KS230" && TPlinkModel != "KP405" && TPlinkModel != "HS103" &&
                    TPlinkModel != "EP10" && TPlinkModel != "ES20M" && TPlinkModel != "HS210") {

                    if (oldtotalState != corrected_total) {
                        this.log("Total - Offset: " + corrected_total);
                        this.setCapabilityValue('meter_power', corrected_total)
                            .catch(this.error);
                    }

                    if (oldpowerState != data.emeter.realtime.power) {
                        this.log('Power changed: ' + data.emeter.realtime.power);
                        this.setCapabilityValue('measure_power', data.emeter.realtime.power)
                            .catch(this.error);
                    }
                    if (oldvoltageState != data.emeter.realtime.voltage) {
                        this.log('Voltage changed: ' + data.emeter.realtime.voltage);
                        this.setCapabilityValue('measure_voltage', data.emeter.realtime.voltage)
                            .catch(this.error);
                    }
                    if (oldcurrentState != data.emeter.realtime.current) {
                        this.log('Current changed: ' + data.emeter.realtime.current);
                        this.setCapabilityValue('measure_current', data.emeter.realtime.current)
                            .catch(this.error);
                    }
                }

                // check if model support dimming
                if (TPlinkModel === "HS220" || TPlinkModel === "ES20M" || TPlinkModel === "KS230") {
                    try {
                        const brightness = this.plug.dimmer.brightness;
                        this.log('Brightness level: ' + brightness);
                        // Update Homey device state for brightness
                    } catch (err) {
                        this.log('Error getting brightness: ', err.message);
                    }
                }
            })
                .catch((err) => {
                    var errRegEx = new RegExp("EHOSTUNREACH", 'g')
                    if (err.message.match(errRegEx)) {
                        unreachableCount += 1;
                        this.log("Device unreachable. Unreachable count: " + unreachableCount + " Discover count: " + discoverCount + " DynamicIP option: " + settings["dynamicIp"]);

                        // attempt autodiscovery once every hour
                        if ((unreachableCount % 360 == 3) && settings["dynamicIp"]) {
                            this.setUnavailable("Device offline");
                            discoverCount += 1;
                            this.log("Unreachable, starting autodiscovery");
                            this.discover();
                        }
                    }
                    this.log("Caught error in getStatus / getSysInfo function: " + err.message);
                });
        } catch (err) {
            this.log("Caught error in getStatus function: " + err.message);
        }

    }

pollDevice(interval) {
    clearInterval(this.pollingInterval);
    this.pollingInterval = setInterval(async () => {
        try {
            await this.getStatus();
        } catch (err) {
            this.log("Error during polling: " + err.message);
            // Optionally, handle reconnection or retry logic here
        }
    }, 1000 * interval);
}


    async discover() {
    let settings = this.getSettings();
    var discoveryOptions = {
        deviceTypes: 'plug',
        discoveryInterval: 10000,
        discoveryTimeout: 5000,
        offlineTolerance: 3
    };

    try {
        // As startDiscovery does not return a promise, it does not need await but errors should be handled appropriately
        const discovery = client.startDiscovery(discoveryOptions);
        
        // Handle new plug event
        discovery.on('plug-new', async (plug) => {
            try {
                if (plug.deviceId === settings["deviceId"]) {
                    await this.setSettings({ settingIPAddress: plug.host });
                    // Stopping discovery after finding the device, assuming one device setup per call
                    client.stopDiscovery();
                    this.log("Discovered online plug: " + plug.deviceId);
                    this.setAvailable();
                    this.log("Resetting unreachable count to 0");
                    unreachableCount = 0;
                    discoverCount = 0;
                }
            } catch (err) {
                this.log('Error updating settings during discovery: ' + err.message);
            }
        });

        // Optionally handle plug-online event if needed
        discovery.on('plug-online', async (plug) => {
            try {
                if (plug.deviceId === settings["deviceId"]) {
                    await this.setSettings({ settingIPAddress: plug.host });
                    // Similar to plug-new, stop discovery once the intended device is online
                    client.stopDiscovery();
                    this.log("Discovered online plug: " + plug.deviceId + " is back online");
                    this.setAvailable();
                }
            } catch (err) {
                this.log('Error handling online plug during discovery: ' + err.message);
            }
        });
    } catch (err) {
        this.log('Discovery failed: ' + err.message);
        // Implement retry logic or further error handling as needed
    }
}

}

module.exports = TPlinkPlugDevice;
'use strict';
const Homey = require('homey');
const {
    Client
} = require('tplink-smarthome-api');
const client = new Client();

// get driver name based on dirname (hs100, hs110, etc.)
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
};

var oldpowerState = "";
var oldtotalState = 0;
var totalOffset = 0;
var oldvoltageState = 0;
var oldcurrentState = 0;
var unreachableCount = 0;
var discoverCount = 0;
var util = require('util');
var TPlinkModel = getDriverName().toUpperCase();


class TPlinkPlugDevice extends Homey.Device {

    async onInit() {
        this.log('Device initialization');
        let device = this;
        var interval = 10;
        let settings = this.getSettings();
        let id = this.getData().id;
        let childId = this.getData().childId; // Retrieve the childId

        this.log('Device ID: ', id);
        this.log('Child ID: ', childId); // Log the childId for debugging
        this.log('name: ', this.getName());
        this.log('class: ', this.getClass());
        this.log('settings IP address: ', settings["settingIPAddress"])
        this.log('Driver ID: ', TPlinkModel);

        // In case the device was not paired with a version including the dynamicIp setting, set it to false
        if (settings["dynamicIp"] === undefined || typeof settings["dynamicIp"] !== 'boolean') {
            this.setSettings({
                dynamicIp: false
            }).catch(this.error);
        }
        this.log("dynamicIp is: " + settings["dynamicIp"]);

        this.log('settings totalOffset: ', settings["totalOffset"])
        totalOffset = settings["totalOffset"];

        // Initialization logic for each socket (childId) of the HS300
        // Since HS300 is a multi-socket device, childId will always be present
        this.log('Initializing socket with Child ID: ', childId);
        // Initialize specific socket based on childId
        // Adjust settings, capabilities, and any other specifics for the socket

        totalOffset = settings["totalOffset"];
        this.pollDevice(interval, childId);

        this.registerCapabilityListener('onoff', value => this.onCapabilityOnoff(value, childId));
        this.registerCapabilityListener('ledonoff', value => this.onCapabilityLedOnoff(value, childId));

        this.pollDevice(interval);

        // Register flow card action listeners
        this.homey.flow.getActionCard('ledOn').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.ledOn(args.device.getSettings().settingIPAddress, childId);
        });

        this.homey.flow.getActionCard('ledOff').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.ledOff(args.device.getSettings().settingIPAddress, childId);
        });

        this.homey.flow.getActionCard('meter_reset').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.meter_reset(args.device.getSettings().settingIPAddress, childId);
        });

        this.homey.flow.getActionCard('undo_meter_reset').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.undo_meter_reset(args.device.getSettings().settingIPAddress, childId);
        });


    } // end onInit

    onAdded() {
        let id = this.getData().id;
        let childId = this.getData().childId; // Retrieve the childId for the socket
        this.log("Device added: " + id + ", Child ID: " + childId);

        let settings = this.getSettings();
        var interval = 10;

        // Call pollDevice with childId to start polling this specific socket
        this.pollDevice(interval, childId);
    }


    // This method is called when the Device is deleted
    onDeleted() {
        let id = this.getData().id;
        let childId = this.getData().childId; // Retrieve the childId for the socket

        this.log("Device deleted: " + id + ", Child ID: " + childId);

        clearInterval(this.pollingInterval);
    }


    async onCapabilityOnoff(value, opts) {
        let settings = this.getSettings();
        let device = settings["settingIPAddress"];
        let childId = this.getData().childId; // Retrieve the childId for the socket
        this.log("Capability called: onoff value: ", value, "for ChildID ", childId);
    
        try {
            if (value) {
                await this.powerOn(device, childId);
            } else {
                await this.powerOff(device, childId);
            }
        } catch (err) {
            this.log("Error in onCapabilityOnoff:", err.message);
            throw err; // Rethrow the error to ensure Homey knows the action failed
        }
    }
    

    async onCapabilityLedOnoff(value, opts) {       
        let childId = this.getData().childId; // Get the childId
        let device = this.getSettings().settingIPAddress;
        this.log("Capability called: LED onoff value: ", value,"for ChildID ", childId);
        
        if (childId) {
            // If childId is present, control the LED of the specific socket on the HS300
            await this.ledOnOffSocket(device, childId, value);
        }
    }
    
// rework needed !!!
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
            return "true";
        } catch (error) {
            return "error";
        }
    }

    async powerOn(device, childId) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            this.log('Turning on device: ' + device + ', Child ID: ' + childId);
            // await this.plug.setPowerState(true, { childId: childId });
                 // Send command directly with childId context
        await this.plug.sendCommand(
            `{"system":{"set_relay_state":{"state":1}}}`, // Command to turn on the device
            childId // Context with childId
        );
        } catch (err) {
            this.log('Error turning device on: ', err.message);
            throw err;
        }
    }
    
    async powerOff(device, childId) {
        try {
            this.log('Turning on device: ' + device + ', Child ID: ' + childId);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            //await this.plug.setPowerState(false, { childId: childId });
                 // Send command directly with childId context
        await this.plug.sendCommand(
            `{"system":{"set_relay_state":{"state":0}}}`, // Command to turn on the device
            childId // Context with childId
        );
        } catch (err) {
            this.log('Error turning device off: ', err.message);
            throw err;
        }
    }
    

    async getPower(device) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
    
            let childId = this.getData().childId; // Get the childId for the socket
            if (childId && sysInfo.children) {
                // If childId is present and the device has multiple sockets
                const childSocket = sysInfo.children.find(child => child.id === childId);
                if (childSocket) {
                    this.log('Relay state for socket ' + childId + ' is ' + (childSocket.state ? 'on' : 'off'));
                    return childSocket.state ? "true" : "false";
                } else {
                    this.log('Child socket not found for childId: ', childId);
                    return "false";
                }
            }
        } catch (err) {
            this.log("Caught error in getPower function: " + err.message);
            return "error";
        }
    }
   //REWORK !!! -  
    getLed(device) {
        const sysInfo = client.getSysInfo(device);
        this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
        this.plug.getSysInfo().then((sysInfo) => {
            if (sysInfo.led_off === 0) {
                this.log('LED on ');
                return "true";
            } else {
                this.log('LED off ');
                return "false";
            }
        })
            .catch((err) => {
                this.log("Caught error in getLed function: " + err.message);
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
       
        meter_reset(device) {
            this.log('Reset meter ');
            const sysInfo = client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            // reset meter for counters in Kasa app. Does not actually clear the total counter though...
            // this.plug.emeter.eraseStats(null);
            this.log('Setting totalOffset to oldtotalState: ' + oldtotalState);
            totalOffset = oldtotalState;
            this.setSettings({
                totalOffset: totalOffset
            }).catch(this.error);
        }

        undo_meter_reset(device) {
            this.log('Undo reset meter, setting totalOffset to 0 ');
            // reset meter for counters in Kasa app. Does not actually clear the total counter though...
            totalOffset = 0;
            this.setSettings({
                totalOffset: totalOffset
            }).catch(this.error);
        }

        async getStatus() {
            let settings = this.getSettings();
            let device = settings.settingIPAddress;
            let childId = this.getData().childId; // Retrieve the childId for the socket
        
            this.log("getStatus for device: " + device + ", Child ID: " + childId);
        
            try {
                const sysInfo = await client.getSysInfo(device);
                this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
        
                if (childId) {
                    // Fetch the relay state for the specific socket
                    const childSocket = sysInfo.children.find(child => child.id === childId);
                    const relayState = childSocket ? childSocket.state === 1 : false;
                    this.setCapabilityValue('onoff', relayState).catch(this.error);
                    this.log('Relay state for child socket ' + childId + ' is ' + (relayState ? 'on' : 'off'));
        
                    // Fetch and update real-time data for the specific socket
                    const realtimeStats = await this.plug.emeter.getRealtime({ childId: childId });
                    if (realtimeStats) {
                        // Update capability values based on realtimeStats
                        this.setCapabilityValue('measure_power', realtimeStats.power || 0).catch(this.error);
                        this.setCapabilityValue('measure_voltage', realtimeStats.voltage || 0).catch(this.error);
                        this.setCapabilityValue('measure_current', realtimeStats.current || 0).catch(this.error);
                        this.log('Updated real-time stats for child socket ' + childId);
                    }
                } else {
                    this.log('Child ID not found for socket');
                    // Handle scenario where childId is not found or not applicable
                }
            } catch (err) {
                var errRegEx = new RegExp("EHOSTUNREACH", 'g');
                if (err.message.match(errRegEx)) {
                    unreachableCount += 1;
                    this.log("Device unreachable. Unreachable count: " + unreachableCount + " Discover count: " + discoverCount + " DynamicIP option: " + settings["dynamicIp"]);
        
                    if ((unreachableCount % 360 === 3) && settings["dynamicIp"]) {
                        this.setUnavailable("Device offline");
                        discoverCount += 1;
                        this.log("Unreachable, starting autodiscovery");
                        this.discover();
                    }
                } else {
                    // Log other errors
                    this.log("Caught error in getStatus function: " + err.message);
                }
            }
        }
        

    pollDevice(interval) {
        clearInterval(this.pollingInterval);
    
        let childId = this.getData().childId; // Retrieve the childId for the socket
    
        this.pollingInterval = setInterval(() => {
            // Poll status
            try {
                if (childId) {
                    // If childId is present, poll the status of the specific socket
                    this.getStatus(childId);
                } else {
                    // For single-socket devices or parent device of multi-socket models
                    // this.getStatus();
                }
            } catch (err) {
                this.log("Error in polling: " + err.message);
            }
        }, 1000 * interval);
    }


    discover() {
        let settings = this.getSettings();
        var discoveryOptions = {
            deviceTypes: 'plug',
            discoveryInterval: 10000,
            discoveryTimeout: 5000,
            offlineTolerance: 3
        };
    
        // Start discovering new plugs
        client.startDiscovery(discoveryOptions);
        
        client.on('plug-new', (plug) => {
            this.log("Discovered new plug: Host - " + plug.host + ", Device ID - " + plug.deviceId);
            
            if (plug.deviceId === settings["deviceId"]) {
                this.setSettings({
                    settingIPAddress: plug.host
                }).catch(this.error);
                
                setTimeout(() => client.stopDiscovery(), 1000);
                this.log("Updated settings for discovered plug: " + plug.deviceId);
                unreachableCount = 0;
                discoverCount = 0;
                this.setAvailable();
            }
        });
    
        client.on('plug-online', (plug) => {
            this.log("Discovered online plug: Host - " + plug.host + ", Device ID - " + plug.deviceId);
            
            if (plug.deviceId === settings["deviceId"]) {
                this.setSettings({
                    settingIPAddress: plug.host
                }).catch(this.error);
                
                setTimeout(() => client.stopDiscovery(), 1000);
                this.log("Updated settings for online plug: " + plug.deviceId);
                unreachableCount = 0;
                discoverCount = 0;
                this.setAvailable();
            }
        });
    }
    
}

module.exports = TPlinkPlugDevice;
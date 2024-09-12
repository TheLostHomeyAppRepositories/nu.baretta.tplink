'use strict';
//debug for API
// process.env.DEBUG = 'tplink-smarthome-api*';

const Homey = require('homey');
const {
    Client
} = require('tplink-smarthome-api');

const client = new Client({
    //debug for API
    //    logLevel: 'debug' // Set the log level to 'debug' for detailed logs
});

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
};

var TPlinkModel = getDriverName().toUpperCase();


class TPlinkPlugDevice extends Homey.Device {

    generateRandomInterval() {
        let interval;
        do {
            interval = 5 + Math.random() * 10; // Random interval
        } while (this.isIntervalTooClose(interval, this.lastInterval));
        this.lastInterval = interval; // Update the last interval
        return interval;
    }

    isIntervalTooClose(newInterval, lastInterval) {
        if (lastInterval === null) return false; // No last interval to compare
        const diff = Math.abs(newInterval - lastInterval);
        return diff < 2; // Define a threshold for 'too close', e.g., less than 2 seconds difference
    }

    async onInit() {
        this.log('EP40 device initialization');
        // Generate a random interval and assign it to 'interval'
        let interval = this.generateRandomInterval();
        let device = this;
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

        this.log('Initializing socket with Child ID: ', childId);
        // Initialize specific socket based on childId
        // Adjust settings, capabilities, and any other specifics for the socket

        this.registerCapabilityListener('onoff', async (value, opts) => {
            const childId = this.getData().childId; 
            return this.onCapabilityOnoff(value, childId);
        });
        
        this.registerCapabilityListener('ledonoff', async (value, opts) => {
            let childId = this.getData().childId; // Dynamically retrieve the childId for the socket
            let device = this.getSettings().settingIPAddress;
            return this.setLedState(device, childId, value);
        });      

        // Register flow card action listeners
        this.homey.flow.getActionCard('ledOn').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.setLedState(args.device.getSettings().settingIPAddress, childId, true);
        });
        
        this.homey.flow.getActionCard('ledOff').registerRunListener(async (args, state) => {
            let childId = args.device.getData().childId; // Retrieve the childId
            return args.device.setLedState(args.device.getSettings().settingIPAddress, childId, false);
        });       

        // Call pollDevice with childId to start polling this specific socket
        this.pollDevice(interval, childId);
    } // end onInit

    onAdded() {

        let id = this.getData().id;
        let childId = this.getData().childId; // Retrieve the childId for the socket
        this.log("Device added: " + id + ", Child ID: " + childId);

        let settings = this.getSettings();

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
        let childId = this.getData().childId; // Dynamically retrieve the childId for the socket
        this.log("Capability called: onoff value: ", value, "for Child ID ", childId);
    
        try {
            // Call the refactored method to set the power state based on the 'value'
            await this.setPowerState(device, childId, value);
        } catch (err) {
            this.log("Error in onCapabilityOnoff:", err.message);
            throw err; // Rethrow the error to ensure Homey knows the action failed
        }
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        try {
            for (const key of changedKeys) {
                switch (key) {
                    case 'settingIPAddress':
                        this.log('IP address changed to ' + newSettings.settingIPAddress);
                        // Re-initialize connection if IP address changes
                        if (!newSettings.dynamicIp) { // Only reconnect if dynamic IP is not used
                            await this.reinitializeConnection(newSettings.settingIPAddress);
                        }
                        break;
                    case 'pollingInterval':
                        const interval = parseInt(newSettings.pollingInterval, 10) || 10; // Ensure there's a fallback interval
                        this.log('Polling interval changed to ' + interval + ' seconds');
                        clearInterval(this.pollingInterval);
                        this.pollDevice(interval); // Start polling with the defined interval
                        break;
                    case 'dynamicIp':
                        this.log('Dynamic IP setting changed to ' + newSettings.dynamicIp);
                        break;
                    default:
                        this.log('Unhandled setting change detected for key:', key);
                        break;
                }
            }
        } catch (error) {
            this.error('Failed to handle settings change:', error);
            throw new Error('Failed to update settings: ' + error.message);
        }
    }

async reinitializeConnection(ipAddress) {
    // Implement the logic to reinitialize the connection
    // For example, update the plug instance
    try {
        const sysInfo = await client.getSysInfo(ipAddress);
        this.plug = client.getPlug({ host: ipAddress, sysInfo });
        this.log('Reinitialized connection to', ipAddress);
    } catch (err) {
        this.error('Error reinitializing connection:', err);
    }
}

    async setPowerState(device, childId, powerState) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            this.log(`Setting power state to ${powerState ? 'ON' : 'OFF'} for device: ${device}, Child ID: ${childId}`);
            await this.plug.sendCommand(`{"system":{"set_relay_state":{"state":${powerState ? 1 : 0}}}}`, childId);
        } catch (err) {
            this.log(`Error setting power state for device: ${device}, Child ID: ${childId}: `, err.message);
            throw err;
        }
    }

    async getLed(device) {
        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });

            const updatedSysInfo = await this.plug.getSysInfo();
            if (updatedSysInfo.led_off === 0) {
                this.log('LED on ');
                return true;
            } else {
                this.log('LED off ');
                return false;
            }
        } catch (err) {
            this.log("Caught error in getLed function: " + err.message);
            return "error";
        }
    }

    // https://plasticrake.github.io/tplink-smarthome-api/classes/Plug.html#setLedState
    // Turn Plug LED on/off (night mode). Does not support childId.
    async setLedState(device, childId, ledState) {
        try {
            this.log(`Setting LED state to ${ledState ? 'ON' : 'OFF'} for device: ${device}, Child ID: ${childId}`);
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo });
            await this.plug.setLedState(ledState);
            await this.setCapabilityValue('ledonoff', ledState);
        } catch (err) {
            this.log(`Error setting LED state for device: ${device}, Child ID: ${childId}: `, err.message);
            throw err;
        }
    }

    async getStatus() {
        let settings = this.getSettings();
        let device = settings.settingIPAddress;
        let childId = this.getData().childId; // Retrieve the childId
        //const sysInfo = client.getSysInfo(device);
        this.log("getStatus for device: " + device + ", Child ID: " + childId);

        try {
            const sysInfo = await client.getSysInfo(device);
            this.plug = client.getPlug({ host: device, sysInfo: sysInfo, childId: childId });

            // Check the relay state of the specific socket
            const childSocket = sysInfo.children.find(child => child.id === childId);
            const relayState = childSocket ? childSocket.state === 1 : false;

            this.setCapabilityValue('onoff', relayState).catch(this.error);
            this.log('Relay state for child socket ' + childId + ' is ' + (relayState ? 'on' : 'off'));

        } catch (err) {
            this.handleErrors(err, settings);
        }
    }


    handleErrors(err, settings) {
        if (err.code === 'ECONNRESET') {
            this.log("Connection reset error: " + err.message);
            // Cooldown delay of 10 seconds
            return new Promise(resolve => setTimeout(resolve, 10000));
        } else if (err.message.includes("EHOSTUNREACH")) {
            this.log(`Device unreachable. DynamicIP option: ${settings["dynamicIp"]}`);
            if (settings["dynamicIp"]) {
                this.setUnavailable("Device offline");
                this.discover();
            }
        } else {
            // other logs silent
            //   this.log("Caught error in getStatus function: " + err.message);
        }
    }


    pollDevice(randomInterval, childIds) {
        clearInterval(this.pollingInterval); // Clear any existing interval

        this.log("Starting polling with interval : ", randomInterval.toFixed(0), " with childIds:", childIds);

        this.pollingInterval = this.homey.setInterval(async () => {
            this.log("Polling for childId:", childIds);
            try {
                await this.getStatus(childIds);
            } catch (err) {
                this.log("Error in polling for childId", childIds, ":", err.message);
            }
        }, randomInterval * 1000); // Multiply by 1000 to convert to milliseconds
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
            // Start discovering new plugs
            const discovery = client.startDiscovery(discoveryOptions);

            // Handle the event when a new plug is discovered
            discovery.on('plug-new', async (plug) => {
                try {
                    this.log("Discovered new plug: Host - " + plug.host + ", Device ID - " + plug.deviceId);

                    if (plug.deviceId === settings["deviceId"]) {
                        await this.setSettings({
                            settingIPAddress: plug.host
                        });
                        client.stopDiscovery();
                        this.log("Updated settings for discovered plug: " + plug.deviceId);
                        this.setAvailable();
                    }
                } catch (error) {
                    this.log('Error handling new plug discovery: ' + error.message);
                }
            });

            // Handle the event when a plug comes online
            discovery.on('plug-online', async (plug) => {
                try {
                    this.log("Discovered online plug: Host - " + plug.host + ", Device ID - " + plug.deviceId);

                    if (plug.deviceId === settings["deviceId"]) {
                        await this.setSettings({
                            settingIPAddress: plug.host
                        });
                        client.stopDiscovery();
                        this.log("Updated settings for online plug: " + plug.deviceId);
                        this.setAvailable();
                    }
                } catch (error) {
                    this.log('Error handling online plug: ' + error.message);
                }
            });
        } catch (err) {
            this.log("Caught error in discover function: " + err.message);
            // Implement retry logic or further error handling as needed
        }
    }


}

module.exports = TPlinkPlugDevice;
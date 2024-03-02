'use strict';
// need Homey module, see SDK Guidelines
const Homey = require('homey');

const {
    Client
} = require('tplink-smarthome-api');
const client = new Client();

// get driver name based on dirname
function getDriverName() {
    var parts = __dirname.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].split('.')[0];
}
var TPlinkModel = getDriverName().toUpperCase();
var myRegEx = new RegExp(TPlinkModel, 'g');

//var devIds = {};
var logEvent = function (eventName, bulb) {
    //this.log(`${(new Date()).toISOString()} ${eventName} ${bulb.model} ${bulb.host} ${bulb.deviceId}`);
    console.log(`${(new Date()).toISOString()} ${eventName} ${bulb.model} ${bulb.host}`);
};

function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

class TPlinkBulbDriver extends Homey.Driver {

    async onPair(session) {
        // socket is a direct channel to the front-end
        var devIds = {};

        try {
            let apidevices = this.getDevices();
            Object.values(apidevices).forEach(device => {

                devIds[device.getSettings().deviceId] = "";
            })
            this.log("Existing devIDs: " + JSON.stringify(devIds));
        } catch (err) {
            this.log(err);
        }

        var id = guid();
        let devices = [{
            "data": {
                "id": id
            },
            "name": "initial_name",
            "settings": {
                "settingIPAddress": "0.0.0.0",
                "totalOffset": 0
            } // initial settings
        }];

        // discover function
        session.setHandler("discover", async (data) => {

            let discoveredDevicesArray = []; // Initialize an array to store discovered devices

            var discoveryOptions = {
                deviceTypes: 'bulb',
                discoveryInterval: 1500,
                discoveryTimeout: 2000
            }
            client.startDiscovery(discoveryOptions);
            this.log('Starting Bulb Discovery');
            client.on('bulb-new', async (bulb) => {
                logEvent('Found Bulb-new type', bulb);
                const sysInfo = await bulb.getSysInfo();
                const deviceName = sysInfo.dev_name || sysInfo.alias || sysInfo.model; //Fallback as per sysinfo available data

                if (bulb.model.match(myRegEx) && !devIds.hasOwnProperty(bulb.deviceId)) {
                    if (!discoveredDevicesArray.some(device => device.deviceId === bulb.deviceId)) {
                        this.log("New Bulb found: " + bulb.host + " model " + bulb.model + " name " + bulb.name + " id " + bulb.deviceId);
                        discoveredDevicesArray.push({
                            ip: bulb.host,
                            name: deviceName,
                            deviceId: bulb.deviceId // Store the device ID
                        });
                    }
                }
            });

            client.on('bulb-online', async (bulb) => {
                logEvent('bulb-online check', bulb);
                const sysInfo = await bulb.getSysInfo();
                const deviceName = sysInfo.dev_name || sysInfo.alias || sysInfo.model; //Fallback as per sysinfo available data

                if (bulb.model.match(myRegEx) && !devIds.hasOwnProperty(bulb.deviceId)) {
                    if (!discoveredDevicesArray.some(device => device.deviceId === bulb.deviceId)) {
                        this.log("Online Bulb found: " + bulb.host + " model " + bulb.model + " name " + bulb.name + " id " + bulb.deviceId);
                        discoveredDevicesArray.push({
                            ip: bulb.host,
                            name: deviceName,
                            deviceId: bulb.deviceId // Store the device ID
                        });
                    }
                }
            });

            setTimeout(() => {
                if (discoveredDevicesArray.length > 0) {
                    session.emit('discovered_devices', discoveredDevicesArray); // Emit the array of discovered devices
                    this.log("Discovered devices: " + JSON.stringify(discoveredDevicesArray));
                    return discoveredDevicesArray; // Return the array
                } else {
                    this.log("No devices discovered");
                    session.emit('discovery_failed', { devicesFound: false });
                    return []; // Return an empty array if no devices were discovered
                }
                return []; // Return an empty array if no devices were discovered
            }, discoveryOptions.discoveryTimeout);
            client.stopDiscovery();
        });

        // this is called when the user presses save settings button in start.html
        session.setHandler("get_devices", async (data) => {
            this.log("Received get_devices data: " + JSON.stringify(data));

            // Ensure data is always treated as an array
            let inputData = Array.isArray(data) ? data : [data];

            let devices = inputData.map(device => {
                // Generate a unique ID for each device
                let deviceId = guid();
                return {
                    data: { id: deviceId },
                    name: device.name,
                    settings: {
                        "settingIPAddress": device.ip,
                        "dynamicIp": false,
                        "totalOffset": 0
                    }
                };
            });

            // Log and return the processed devices
            this.log("Processed devices: " + JSON.stringify(devices));

            // Set passed pair settings in variables
            //this.log("Got get_devices from front-end, IP =", data.ipaddress, " Name = ", data.deviceName);
            session.emit('continue', null);

            // this method is run when Homey.emit('list_devices') is run on the front-end
            // which happens when you use the template `list_devices`

            session.setHandler("list_devices", async (data) => {

                return devices;
            });
        });

        session.setHandler("disconnect", () => {
            this.log("Pairing is finished (done or aborted)");
        })
    }
}

module.exports = TPlinkBulbDriver;

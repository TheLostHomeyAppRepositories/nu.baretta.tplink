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
var logEvent = function (eventName, plug) {
    //this.log(`${(new Date()).toISOString()} ${eventName} ${plug.model} ${plug.host} ${plug.deviceId}`);
    console.log(`${(new Date()).toISOString()} ${eventName} ${plug.model} ${plug.host}`);
};

function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

class TPlinkPlugDriver extends Homey.Driver {

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
                deviceTypes: 'plug',
                discoveryInterval: 1500,
                discoveryTimeout: 2000
            }
            client.startDiscovery(discoveryOptions);
            this.log('Starting Plug Discovery');
client.on('plug-new', async (plug) => {
    try {
        logEvent('Found plug-new type', plug);
        const sysInfo = await plug.getSysInfo();
        const deviceName = sysInfo.name || sysInfo.alias || sysInfo.dev_name || sysInfo.model; // Fallback as per sysinfo available data

        if (plug.model.match(myRegEx) && !devIds.hasOwnProperty(plug.deviceId)) {
            if (!discoveredDevicesArray.some(device => device.deviceId === plug.deviceId)) {
                this.log("New Plug found: " + plug.host + " model " + plug.model + " name " + plug.name + " id " + plug.deviceId);
                discoveredDevicesArray.push({
                    ip: plug.host,
                    name: deviceName,
                    deviceId: plug.deviceId // Store the device ID
                });
            }
        }
    } catch (err) {
        this.log(`Error discovering new plug: ${err.message}`);
    }
});

client.on('plug-online', async (plug) => {
    try {
        const sysInfo = await plug.getSysInfo();
        const deviceName = sysInfo.name || sysInfo.alias || sysInfo.dev_name || sysInfo.model; // Fallback as per sysinfo available data

        if (plug.model.match(myRegEx) && !devIds.hasOwnProperty(plug.deviceId)) {
            if (!discoveredDevicesArray.some(device => device.deviceId === plug.deviceId)) {
                this.log("Online plug found: " + plug.host + " model " + plug.model + " name " + plug.name + " id " + plug.deviceId);
                discoveredDevicesArray.push({
                    ip: plug.host,
                    name: deviceName,
                    deviceId: plug.deviceId // Store the device ID
                });
            }
        }
    } catch (err) {
        this.log(`Error discovering online plug: ${err.message}`);
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
            //            return devices;


            // Set passed pair settings in variables
            //this.log("Got get_devices from front-end, IP =", data.ipaddress, " Name = ", data.deviceName);
            session.emit('continue', null);

            // this method is run when Homey.emit('list_devices') is run on the front-end
            // which happens when you use the template `list_devices`

            session.setHandler("list_devices", async (data) => {
                //this.log("List_devices data: " + JSON.stringify(data));

                return devices;
            });
        });

        session.setHandler("disconnect", () => {
            this.log("Pairing is finished (done or aborted)");
        })
    }
}

module.exports = TPlinkPlugDriver;

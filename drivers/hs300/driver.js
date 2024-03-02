'use strict';
// need Homey module, see SDK Guidelines
const Homey = require('homey');

const {
    Client
} = require('tplink-smarthome-api');
const client = new Client();

// get driver name based on dirname (hs100, hs110, etc.)
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
                //   this.log("Existing deviceId: " + device.getSettings().deviceId);
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

                if (plug.model.match(myRegEx)) {
                    const sysInfo = await plug.getSysInfo();

                    if (sysInfo.children) {
                        const childrenMap = plug.children; // Get the map of children
                        childrenMap.forEach((child, childId) => {
                            const childName = child.alias || `Socket ${childId}`;

                            if (!discoveredDevicesArray.some(device => device.childId === childId)) {
                                this.log("New Socket found: " + childName + " in " + plug.host + " id " + childId);
                                discoveredDevicesArray.push({
                                    ip: plug.host,
                                    name: childName,
                                    deviceId: plug.deviceId,
                                    childId: childId
                                });
                            }
                        });
                    }
                }
            });


            client.on('plug-online', (plug) => {
                if (plug.model.match(myRegEx) && !devIds.hasOwnProperty(plug.deviceId)) {

                    if (!discoveredDevicesArray.some(device => device.childId === childId)) {
                        this.log("New Socket found online: " + childName + " in " + plug.host + " id " + childId);
                        discoveredDevicesArray.push({
                            ip: plug.host,
                            name: childName,
                            deviceId: plug.deviceId,
                            childId: childId
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
            }, discoveryOptions.discoveryTimeout);
            client.stopDiscovery();
        });

        // this is called when the user presses save settings button in start.html
        session.setHandler("get_devices", async (data) => {
            this.log("Received get_devices data: " + JSON.stringify(data));

            if (data[0].name === "HS300dummy") {
                this.log("Processed devices for manual IP");
                // Manually entered IP, initiate specific discovery
                let specificDeviceOptions = {
                    deviceTypes: ['plug'],
                    devices: [{ host: data[0].ip }]
                };
                client.startDiscovery(specificDeviceOptions);
                
                client.on('plug-new', async (plug) => {
                    if (plug.host === data[0].ip && plug.model.match(myRegEx)) {
                        const sysInfo = await plug.getSysInfo();
                        if (sysInfo.children) {
                            let devices = sysInfo.children.map(child => {
                                let deviceId = guid();
                                return {
                                    data: { id: deviceId, childId: child.id },
                                    name: child.alias || data[0].name,
                                    settings: {
                                        "settingIPAddress": plug.host,
                                        "dynamicIp": false,
                                        "totalOffset": 0
                                    }
                                };
                            });
        
                            this.log("Processed devices for manual IP: " + JSON.stringify(devices));
                            session.emit('continue', null);
        
                            session.setHandler("list_devices", async () => {
                                return devices;
                            });
                        }
                    }
                });

            } else {
                this.log("Processed devices for autodiscovered devices");
                // Handle normally for autodiscovered devices
                let inputData = Array.isArray(data) ? data : [data];

            let devices = inputData
                .filter(device => device.childId) // Filter to include only devices with a childId
                .map(device => {
                    let deviceId = guid();
                    return {
                        data: { id: device.deviceId, childId: device.childId },
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
            
            }

            
        });

        session.setHandler("disconnect", () => {
            let discoveredDevicesArray = []; // Initialize an array to store discovered devices
            this.log("Pairing is finished (done or aborted)");
        })
    }
}

module.exports = TPlinkPlugDriver;

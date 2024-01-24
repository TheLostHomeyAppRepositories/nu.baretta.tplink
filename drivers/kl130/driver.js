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
            let apidevices = await this.getDevices();
            Object.values(apidevices).forEach(device => {
                this.log("deviceId: " + device.getSettings().deviceId);
                devIds[device.getSettings().deviceId] = "";
            })
            this.log(devIds);
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
            this.log('Starting Bulb Discovery');

            // discover new bulbs
            // TODO: use API's discovery options (exclude MAC addresses, timeout, interval)
            var discoveryOptions = {
                deviceTypes: 'bulb',
                discoveryInterval: 2500,
                discoveryTimeout: 9000
            }
            client.startDiscovery(discoveryOptions);
            client.on('bulb-new', (bulb) => {
                logEvent('bulb-new', bulb);

                if (bulb.model.match(myRegEx)) {
                    // check if device is known
                    if (devIds.hasOwnProperty(bulb.deviceId)) {
                        this.log("Key found in devices: " + JSON.stringify(devIds));
                        this.log("Device " + bulb.host + " is known, skipping. Model: " + bulb.model + " name " + bulb.name + " mac " + bulb.mac + " id " + bulb.deviceId);
                    } else {
                        this.log("Bulb found: " + bulb.host + " model " + bulb.model + " name " + bulb.name + " mac " + bulb.mac + " id " + bulb.deviceId);

                        var data = {
                            ip: bulb.host,
                            name: bulb.name
                        }
                        session.emit('found', data);
                        setTimeout(function () {
                            client.stopDiscovery()
                        }, 1000);
                        this.log("Discovered new bulb: " + data.id + " name " + data.name);
                        return "data";
                    }
                }
            })
            client.on('bulb-online', (bulb) => {
                logEvent('bulb-online', bulb);
                if (bulb.model.match(myRegEx)) {
                    if (devIds.hasOwnProperty(bulb.deviceId)) {
                        this.log("Key found in devices: " + JSON.stringify(devIds));
                        this.log("Device " + bulb.host + " is known, skipping. Model: " + bulb.model + " name " + bulb.name + " mac " + bulb.mac + " id " + bulb.deviceId);
                    } else {
                        this.log("Online bulb found: " + bulb.host + " model " + bulb.model + " name " + bulb.name + " mac " + bulb.mac + " id " + bulb.deviceId);

                        var data = {
                            ip: bulb.host,
                            name: bulb.name
                        }
                        session.emit('found', data);
                        setTimeout(function () {
                            client.stopDiscovery()
                        }, 1000);
                        this.log("Discovered online bulb: " + data.name);
                        return "data";
                    }
                }
            })
        });

        // this is called when the user presses save settings button in start.html
        session.setHandler("get_devices", async (data) => {
            this.log("Get_devices data: " + JSON.stringify(data));
            devices = [{
                data: {
                    id: id
                },
                name: data.deviceName,
                settings: {
                    "settingIPAddress": data.ipaddress,
                    "dynamicIp": false,
                    "totalOffset": 0
                } // initial settings
            }];

            // Set passed pair settings in variables
            this.log("Got get_devices from front-end, IP =", data.ipaddress, " Name = ", data.deviceName);
            session.emit('continue', null);

            // this method is run when Homey.emit('list_devices') is run on the front-end
            // which happens when you use the template `list_devices`

            session.setHandler('list_devices', (data, callback) => {

                this.log("List_devices data: " + JSON.stringify(data));

                return devices;
            });
        });

        session.setHandler("disconnect", () => {
            this.log("Pairing is finished (done or aborted)");
        })
    }
}

module.exports = TPlinkBulbDriver;
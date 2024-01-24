This app lets you control TP-Link Smart Plugs HS100 (plug with no energy monitoring) HS110 (plug with energy monitoring) and Smart Bulbs LB100/110/120 and LB130 as well as the KL50/60/110/120/130 and HS200 from within flows and the (mobile) app

Usage note:
Use fixed IP addresses for the TP Link devices by reserving IP addresses in the DHCP server for each device if you can. In case this is not possible, enable the option to use dynamic IP addresses in the settings. The app will then attempt to rediscover the device each time the IP address has changed.

This app is based on the following resources:

- The tplink-smarthome-api: https://github.com/plasticrake/tplink-smarthome-api
- https://github.com/ggeorgovassilis/linuxscripts/tree/master/tp-link-hs100-smartplug
- https://www.softscheck.com/en/reverse-engineering-tp-link-hs110 
- https://github.com/DaveGut/TP-Link-Bulbs  

Kudo's to Patrick Seal for the fantastic job on the TP Link smarthome API!


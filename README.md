# Air Purifier setup

A one-time USB installer for DIY ESP32 air purifiers. It runs entirely in Chrome or Edge using Web Serial.

- It installs the purifier firmware (V1.7+). Later updates are delivered over WiFi with Blynk.Air.
- Before writing anything, it saves a full backup of the board to the user's laptop. A restore button can put that backup back.
- No device keys are stored in this repository. Each purifier's key travels only in the private link's `#fragment`, which browsers never send to the web server.

Third-party code: [esptool-js](https://github.com/espressif/esptool-js) 0.5.7 (Apache-2.0), in `vendor/`.

[Homey App Store](https://homey.app/a/com.gruijter.blemower) | [Community Forum](https://community.homey.app/t/157241)

# BLE Mower MQTT - Homey App

Connect Gardena Minimo and Husqvarna BLE mowers locally to Homey via MQTT. This app allows you to integrate your Bluetooth lawnmower with Homey without relying on cloud APIs.

## Compatible Mowers

This app is designed for robotic lawnmowers equipped with Bluetooth (BLE) that use the standard Husqvarna/Gardena BLE communication protocol:
* **Gardena Sileno Minimo** (e.g., Minimo 250, Minimo 500)
* **Gardena Sileno City & Life** (Bluetooth-enabled models)
* **Husqvarna Automower** (models equipped with Bluetooth / Automower Connect@Home, such as the Aspire R4 and many 300/400-series mowers within Bluetooth range)

---

## Use Cases

With the integration into Homey, you can set up smart Flows to optimize your mowing schedule. Some popular use cases:

* 🌧️ **Do not mow when it rains (Rain protection)**
  Mowing in the rain is bad for your lawn and makes the mower extremely dirty. Link a rain sensor or a weather app to Homey and activate a Flow: *If it rains -> Send the mower straight to its charging dock.*
* 🚷 **Do not mow when people are in the garden**
  Use presence detection or motion sensors in the garden: *If motion is detected in the garden -> Pause mowing.* Once everyone is back inside, the mowing schedule can be resumed.
* 🔋 **Smart charging based on energy prices**
  If you have dynamic energy tariffs, you can turn off power to the charging station (via a smart plug) during peak hours and let the mower charge only during cheap hours.
* 🚨 **Theft and tilt protection**
  Receive a push notification on your phone or activate your alarm system when the mower is lifted or flipped (*Lift Alarm* or *Upside Down Alarm* becomes active).

---

## Prerequisites & Installation (Guide)

To use this app, a local bridge between the Bluetooth mower and your MQTT network is required. Follow these steps to set up the infrastructure:

### 1. MQTT Broker
An active MQTT broker must be running on your network.
* **No broker present?** You can easily install the **MQTT Broker** app on your Homey Pro to spin up a local broker.

### 2. BLE to MQTT Gateway (Bridge)
Because the Homey Pro is often placed too far from the garden (or to offload BLE connection limits), you need a bridge to capture the BLE signals from the mower and forward them to your MQTT broker.
* You can set this up using a **Raspberry Pi** (or any other Bluetooth-enabled device) placed near the garden/mower.
* Running the gateway inside a **Docker** container is recommended for a stable and easy setup.

### 3. Configuration & Setup Instructions
Please refer to the gateway's GitHub repository for the full guide, Docker-compose files, and configuration instructions:
🔗 **[GardenaMower-BLE-MQTT GitHub Repository](https://github.com/gruijter/GardenaMower-BLE-MQTT)**

Once the gateway is running and publishing data to your MQTT broker, add the mower as a new device in Homey and fill in the MQTT connection details.

DONATE
If you like the app, don’t hesitate to DONATE here: https://paypal.me/gruijter 
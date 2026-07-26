/*
 * com.gruijter.blemower device.js
 *
 * Copyright (c) 2026 Robin de Gruijter (gruijter@hotmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const { promisify } = require('util');
const Homey = require('homey');

const sleep = promisify(setTimeout);

module.exports = class MyDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    try {
      this.log('MyDevice has been initialized:', this.getName());
      this.settings = this.getSettings();
      this.statusTopic = `${this.settings.topic}/status`;
      this.commandTopic = `${this.settings.topic}/command`;
      this.bridgeOnline = undefined;
      this.mowerOnline = undefined;

      await this.migrate();
      await this.connectMQTT();
      this.registerListeners();

      this.restarting = false;
      const lastColVal = this.getCapabilityValue('mower_collisions');
      this.lastCollisions = typeof lastColVal === 'number' ? lastColVal : undefined;

      const lastCyclesVal = this.getCapabilityValue('mower_charging_cycles');
      this.lastChargingCycles = typeof lastCyclesVal === 'number' ? lastCyclesVal : undefined;

      const lastRunVal = this.getCapabilityValue('mower_running_time');
      this.lastRunningTimeSeconds = typeof lastRunVal === 'number' ? lastRunVal * 3600 : undefined;

      this.updateAvailability();
    } catch (error) {
      this.error(error);
      this.restartDevice(60 * 1000).catch((err) => this.error(err));
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('MyDevice settings were changed:', changedKeys);
    this.settings = newSettings;
    this.statusTopic = `${this.settings.topic}/status`;
    this.commandTopic = `${this.settings.topic}/command`;

    // Only restart the connection if actual connection settings changed
    const connectionKeys = ['host', 'port', 'username', 'password', 'topic'];
    const connectionChanged = changedKeys.some((key) => connectionKeys.includes(key));

    if (connectionChanged) {
      this.log('Connection settings changed, restarting connection...');
      this.restartDevice(1000).catch((err) => this.error(err));
    }

    if (changedKeys.includes('mow_duration') && this.client && this.client.connected) {
      const seconds = newSettings.mow_duration * 60;
      this.log(`Publishing new custom mow duration: ${seconds} seconds`);
      this.client.publish(`${this.settings.topic}/command`, `MOW_DURATION ${seconds}`)
        .catch((err) => this.error('Failed to publish custom mow duration:', err));
    }

    if (changedKeys.includes('drive_past_wire') && this.client && this.client.connected) {
      this.log(`Publishing new drive past wire distance: ${newSettings.drive_past_wire} mm`);
      this.client.publish(`${this.settings.topic}/command`, `DRIVE_PAST_WIRE ${newSettings.drive_past_wire}`)
        .catch((err) => this.error('Failed to publish drive past wire:', err));
    }

    if (changedKeys.includes('reversing_distance') && this.client && this.client.connected) {
      this.log(`Publishing new reversing distance: ${newSettings.reversing_distance} mm`);
      this.client.publish(`${this.settings.topic}/command`, `REVERSING_DISTANCE ${newSettings.reversing_distance}`)
        .catch((err) => this.error('Failed to publish reversing distance:', err));
    }
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
    if (this.client) {
      try {
        await this.client.end();
      } catch (err) {
        this.error('Error ending MQTT client on delete:', err);
      }
    }
  }

  /**
   * onUninit is called when the device is unloaded.
   */
  async onUninit() {
    this.log('MyDevice has been uninitialized');
    if (this.client) {
      try {
        await this.client.end();
      } catch (err) {
        this.error('Error ending MQTT client on uninit:', err);
      }
    }
  }

  /**
   * Restarts the connection with a delay
   */
  async restartDevice(delay = 5000) {
    if (this.restarting) return;
    this.restarting = true;

    this.updateAvailability();

    if (this.client) {
      try {
        await this.client.end();
      } catch (err) {
        this.error('Error ending client on restart:', err);
      }
      this.client = null;
    }

    this.log(`Device will restart connection in ${delay / 1000} seconds`);
    await sleep(delay);
    this.onInit().catch((error) => this.error('Error in onInit during restart:', error));
  }

  /**
   * Connects to the MQTT broker and sets up event handlers
   */
  async connectMQTT() {
    try {
      if (!this.settings.host) throw new Error('No MQTT server configured');
      if (this.client) {
        await this.client.end();
        this.client = null;
      }

      const handleMessage = async (topic, message) => {
        try {
          const payloadStr = message.toString().trim();

          if (topic === `${this.settings.topic}/availability`) {
            this.bridgeOnline = payloadStr === 'online';
            this.log(`Bridge availability updated: ${payloadStr}`);
            this.updateAvailability();
            return;
          }

          if (topic === `${this.settings.topic}/mower`) {
            this.mowerOnline = payloadStr === 'online';
            this.log(`Mower connectivity updated: ${payloadStr}`);
            this.updateAvailability();
            return;
          }

          if (topic !== this.statusTopic) return;

          this.log('Received status update:', payloadStr);
          const data = JSON.parse(payloadStr);

          // Update customMowDuration if present in status JSON
          if (data.customMowDuration !== undefined) {
            const durationSeconds = parseInt(data.customMowDuration, 10);
            if (!Number.isNaN(durationSeconds)) {
              const durationMinutes = Math.round(durationSeconds / 60);
              if (this.settings.mow_duration !== durationMinutes) {
                this.setSetting('mow_duration', durationMinutes);
              }
            }
          }

          // Update measure_battery and alarm_battery (low battery alarm below 15%)
          if (data.Battery !== undefined) {
            const batteryVal = Number(data.Battery);
            if (!Number.isNaN(batteryVal)) {
              this.setCapabilityValue('measure_battery', batteryVal).catch((err) => this.error(err));
              this.setCapabilityValue('alarm_battery', batteryVal < 15).catch((err) => this.error(err));
            }
          }

          // Update battery_charging_state (values: "charging", "discharging", "idle")
          if (data.Charging !== undefined) {
            let chargingState = 'idle';
            if (data.Charging === 'ON') {
              chargingState = 'charging';
            } else if (data.Activity === 'MOWING' || data.Activity === 'GOING_HOME') {
              chargingState = 'discharging';
            }
            this.setCapabilityValue('battery_charging_state', chargingState).catch((err) => this.error(err));
          }

          // Determine if safety stop is active (State = STOPPED and Activity = NONE)
          const currentStateText = data.State !== undefined ? data.State : this.getCapabilityValue('mower_state_text');
          const currentActivity = data.Activity !== undefined ? data.Activity : this.getCapabilityValue('mower_activity');
          const safetyStop = currentStateText === 'STOPPED' && currentActivity === 'NONE';

          // Update alarm_safety (boolean)
          this.setCapabilityValue('alarm_safety', safetyStop).catch((err) => this.error(err));

          // Determine if an active error is present
          const hasError = !!(data.LastError && data.LastError !== 'UNKNOWN' && data.LastError !== 'NO_ERROR' && data.LastError !== 'NONE');

          // Update mower_state (picker: "mowing", "docked", "paused", "error")
          let mowerState = 'paused';
          if (safetyStop || hasError) {
            mowerState = 'error';
          } else if (data.Activity === 'MOWING') {
            mowerState = 'mowing';
          } else if (data.Activity === 'PARKED' || data.Activity === 'GOING_HOME') {
            mowerState = 'docked';
          } else if (data.State === 'IN_OPERATION') {
            mowerState = 'mowing';
          } else if (data.State === 'PAUSED' || data.Activity === 'PAUSED') {
            mowerState = 'paused';
          }
          this.setCapabilityValue('mower_state', mowerState).catch((err) => this.error(err));

          // Fire mower_state_changed trigger if value actually changed
          if (mowerState !== this._lastMowerState) {
            this._lastMowerState = mowerState;
            this.driver.homey.flow.getDeviceTriggerCard('mower_state_changed')
              .trigger(this, {}, { state: mowerState })
              .catch((err) => this.error('mower_state_changed trigger error:', err));
          }

          // Update alarm_stuck (boolean)
          this.setCapabilityValue('alarm_stuck', hasError).catch((err) => this.error(err));

          // Update mower_activity (custom text capability)
          if (data.Activity !== undefined) {
            this.setCapabilityValue('mower_activity', data.Activity).catch((err) => this.error(err));

            // Fire mower_activity_changed trigger if value actually changed
            if (data.Activity !== this._lastActivity) {
              this._lastActivity = data.Activity;
              this.driver.homey.flow.getDeviceTriggerCard('mower_activity_changed')
                .trigger(this, { activity: data.Activity }, {})
                .catch((err) => this.error('mower_activity_changed trigger error:', err));
            }
          }

          // Update mower_state_text (custom text capability)
          if (data.State !== undefined) {
            this.setCapabilityValue('mower_state_text', data.State).catch((err) => this.error(err));
          }

          // Update next_start_schedule (formatted string in Homey local timezone, e.g. "Jul 07 15:00")
          if (data.NextStartSchedule !== undefined) {
            try {
              const rawDate = new Date(data.NextStartSchedule);
              if (!Number.isNaN(rawDate.getTime()) && rawDate.getTime() > Date.now() - 60000) {
                // Round to nearest minute (e.g. 12:59:41 UTC -> 13:00:00 UTC)
                const startDate = new Date(Math.round(rawDate.getTime() / 60000) * 60000);

                let timeZone = 'UTC';
                try {
                  timeZone = this.homey.clock.getTimezone();
                } catch (e) {
                  // Fallback if clock API is unavailable
                }

                const parts = new Intl.DateTimeFormat('en-US', {
                  timeZone,
                  month: 'short',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
                }).formatToParts(startDate);

                const partMap = {};
                for (const p of parts) {
                  partMap[p.type] = p.value;
                }

                const formatted = `${partMap.month} ${partMap.day} ${partMap.hour}:${partMap.minute}`;
                this.setCapabilityValue('next_start_schedule', formatted).catch((err) => this.error(err));
              }
            } catch (err) {
              this.error('Failed to parse NextStartSchedule:', err);
            }
          }

          // Update mower_remaining_time (minutes, 0 when not mowing)
          if (data.RemainingMowTime !== undefined) {
            const remainingSecs = Number(data.RemainingMowTime);
            if (!Number.isNaN(remainingSecs)) {
              const remainingMins = Math.round(remainingSecs / 60);
              this.setCapabilityValue('mower_remaining_time', remainingMins).catch((err) => this.error(err));
            }
          }

          // Update mower_collisions (integer number)
          if (data.numberOfCollisions !== undefined) {
            const collisions = Number(data.numberOfCollisions);
            if (!Number.isNaN(collisions)) {
              if (this.lastCollisions === undefined || collisions <= this.lastCollisions + 100) {
                if (this.lastCollisions !== undefined && collisions > this.lastCollisions) {
                  this.log(`Collision count increased from ${this.lastCollisions} to ${collisions}. Triggering collision alarm.`);
                  this.triggerCollisionAlarm().catch((err) => this.error(err));
                }
                this.lastCollisions = collisions;
                this.setCapabilityValue('mower_collisions', collisions).catch((err) => this.error(err));
              } else {
                this.error(`Rejected suspicious collisions jump: ${this.lastCollisions} -> ${collisions}`);
              }
            }
          }

          // Update mower_running_time (hours, float rounded to 1 decimal place)
          if (data.totalRunningTime !== undefined) {
            const runningSeconds = Number(data.totalRunningTime);
            if (!Number.isNaN(runningSeconds)) {
              if (this.lastRunningTimeSeconds === undefined || runningSeconds <= this.lastRunningTimeSeconds + 604800) {
                const runningHrs = Math.round((runningSeconds / 3600) * 10) / 10;
                this.setCapabilityValue('mower_running_time', runningHrs).catch((err) => this.error(err));
                this.lastRunningTimeSeconds = runningSeconds;
              } else {
                this.error(`Rejected suspicious totalRunningTime jump: ${this.lastRunningTimeSeconds} -> ${runningSeconds}`);
              }
            }
          }

          // Update mower_cutting_time (hours, float rounded to 1 decimal place)
          if (data.totalCuttingTime !== undefined) {
            const cuttingSeconds = Number(data.totalCuttingTime);
            if (!Number.isNaN(cuttingSeconds)) {
              const cuttingHrs = Math.round((cuttingSeconds / 3600) * 10) / 10;
              this.setCapabilityValue('mower_cutting_time', cuttingHrs).catch((err) => this.error(err));
            }
          }

          // Update mower_error (custom text capability)
          if (data.LastError !== undefined) {
            this.setCapabilityValue('mower_error', data.LastError).catch((err) => this.error(err));

            // Fire mower_error_occurred trigger if a real error occurred
            if (data.LastError !== 'UNKNOWN' && data.LastError !== this._lastError) {
              this._lastError = data.LastError;
              this.driver.homey.flow.getDeviceTriggerCard('mower_error_occurred')
                .trigger(this, { error: data.LastError }, {})
                .catch((err) => this.error('mower_error_occurred trigger error:', err));
            }
            if (data.LastError === 'UNKNOWN') this._lastError = 'UNKNOWN';
          }

          // Update mower_charging_cycles (integer number)
          if (data.numberOfChargingCycles !== undefined) {
            const cycles = Number(data.numberOfChargingCycles);
            if (!Number.isNaN(cycles)) {
              if (this.lastChargingCycles === undefined || cycles <= this.lastChargingCycles + 20) {
                this.setCapabilityValue('mower_charging_cycles', cycles).catch((err) => this.error(err));
                this.lastChargingCycles = cycles;
              } else {
                this.error(`Rejected suspicious numberOfChargingCycles jump: ${this.lastChargingCycles} -> ${cycles}`);
              }
            }
          }

          // Update measure_signal_strength (dBm RSSI number)
          if (data.RSSI !== undefined) {
            const rssi = Number(data.RSSI);
            if (!Number.isNaN(rssi)) {
              this.setCapabilityValue('measure_signal_strength', rssi).catch((err) => this.error(err));
            }
          }

          // Update new custom/standard sensors
          if (data.collision !== undefined) {
            this.setCapabilityValue('alarm_collision', !!data.collision).catch((err) => this.error(err));
          }
          if (data.lift !== undefined) {
            this.setCapabilityValue('alarm_lift', !!data.lift).catch((err) => this.error(err));
          }
          if (data.upsideDown !== undefined) {
            this.setCapabilityValue('alarm_upside_down', !!data.upsideDown).catch((err) => this.error(err));
          }
          if (data.mowerTemperature !== undefined) {
            this.setCapabilityValue('measure_temperature', Number(data.mowerTemperature)).catch((err) => this.error(err));
          }
          if (data.batteryTemperature !== undefined) {
            this.setCapabilityValue('measure_temperature.battery', Number(data.batteryTemperature)).catch((err) => this.error(err));
          }
          if (data.batteryVoltage !== undefined) {
            this.setCapabilityValue('measure_voltage', Number(data.batteryVoltage)).catch((err) => this.error(err));
          }
          if (data.batteryCurrent !== undefined) {
            this.setCapabilityValue('measure_current', Number(data.batteryCurrent) / 1000).catch((err) => this.error(err));
          }
          if (data.loopSignalStrength !== undefined) {
            this.setCapabilityValue('measure_signal_strength.loop', Number(data.loopSignalStrength)).catch((err) => this.error(err));
          }
          if (data.spotCuttingState !== undefined) {
            const isSpotCutting = Number(data.spotCuttingState) > 0;
            this.setCapabilityValue('mower_spot_cut', isSpotCutting).catch((err) => this.error(err));
          }
          if (data.pitch !== undefined) {
            this.setCapabilityValue('mower_pitch', Number(data.pitch) / 10).catch((err) => this.error(err));
          }
          if (data.roll !== undefined) {
            this.setCapabilityValue('mower_roll', Number(data.roll) / 10).catch((err) => this.error(err));
          }

          // Update toggles (eco mode, garage, radar, frost sensor, sensor control)
          if (data.ecoMode !== undefined) {
            this.setCapabilityValue('mower_eco_mode', data.ecoMode === 'ON').catch((err) => this.error(err));
          }
          if (data.garageEnabled !== undefined) {
            this.setCapabilityValue('mower_garage_enabled', data.garageEnabled === 'ON').catch((err) => this.error(err));
          }
          if (data.radarEnabled !== undefined) {
            this.setCapabilityValue('mower_radar_enabled', data.radarEnabled === 'ON').catch((err) => this.error(err));
          }
          if (data.frostSensorEnabled !== undefined) {
            this.setCapabilityValue('mower_frost_protection', data.frostSensorEnabled === 'ON').catch((err) => this.error(err));
          }
          if (data.sensorControlEnabled !== undefined) {
            this.setCapabilityValue('mower_sensor_control', data.sensorControlEnabled === 'ON').catch((err) => this.error(err));
          }

          // Update device info settings if not already set or if changed
          if (data.Manufacturer && this.settings.manufacturer !== String(data.Manufacturer)) {
            this.setSetting('manufacturer', String(data.Manufacturer));
          }
          if (data.Model && this.settings.model !== String(data.Model)) {
            this.setSetting('model', String(data.Model));
          }
          if (data.SerialNumber && this.settings.serialNumber !== String(data.SerialNumber)) {
            this.setSetting('serialNumber', String(data.SerialNumber));
          }
          if (data.Schedule && this.settings.schedule !== String(data.Schedule)) {
            this.setSetting('schedule', String(data.Schedule));
          }
          if (data.SoftwarePlatform && this.settings.software_platform !== String(data.SoftwarePlatform)) {
            this.setSetting('software_platform', String(data.SoftwarePlatform));
          }
          if (data.SoftwareVersion && this.settings.software_version !== String(data.SoftwareVersion)) {
            this.setSetting('software_version', String(data.SoftwareVersion));
          }
          if (data.SoftwareBundle && this.settings.software_bundle !== String(data.SoftwareBundle)) {
            this.setSetting('software_bundle', String(data.SoftwareBundle));
          }
          if (data.HardwareRevision !== undefined && this.settings.hardware_revision !== String(data.HardwareRevision)) {
            this.setSetting('hardware_revision', String(data.HardwareRevision));
          }
          if (data.ProductionTime && this.settings.production_time !== String(data.ProductionTime)) {
            this.setSetting('production_time', String(data.ProductionTime));
          }

          // Update drive_past_wire setting
          if (data.drivePastWire !== undefined && this.settings.drive_past_wire !== Number(data.drivePastWire)) {
            const val = Number(data.drivePastWire);
            if (!Number.isNaN(val)) {
              this.setSetting('drive_past_wire', val);
            }
          }

          // Update reversing_distance setting
          if (data.reversingDistance !== undefined && this.settings.reversing_distance !== Number(data.reversingDistance)) {
            const val = Number(data.reversingDistance);
            if (!Number.isNaN(val)) {
              this.setSetting('reversing_distance', val);
            }
          }

        } catch (err) {
          this.error('Failed to parse or map incoming MQTT status message:', err);
        }
      };

      const subscribeTopics = async () => {
        try {
          this.log(`Subscribing to ${this.statusTopic}`);
          await this.client.subscribe(this.statusTopic);

          const availabilityTopic = `${this.settings.topic}/availability`;
          this.log(`Subscribing to ${availabilityTopic}`);
          await this.client.subscribe(availabilityTopic);

          const mowerTopic = `${this.settings.topic}/mower`;
          this.log(`Subscribing to ${mowerTopic}`);
          await this.client.subscribe(mowerTopic);

          this.log('MQTT subscriptions successful');
        } catch (error) {
          this.error('Subscription failed:', error);
        }
      };

      this.log('Connecting to MQTT broker:', this.settings.host);
      this.client = await this.driver.connectMQTT(this.settings);

      this.client
        .on('error', (error) => {
          this.error('MQTT Client Error:', error);
          this.restartDevice().catch((err) => this.error(err));
        })
        .on('offline', () => {
          this.log('MQTT broker went offline');
          this.updateAvailability();
        })
        .on('reconnect', () => this.log('MQTT client attempting reconnect'))
        .on('close', () => {
          this.log('MQTT client connection closed');
          this.updateAvailability();
        })
        .on('connect', () => {
          this.log('MQTT connection established / restored');
          this.updateAvailability();
          subscribeTopics().catch((err) => this.error('Error subscribing to topics:', err));
        })
        .on('message', handleMessage);

      if (this.client.connected) {
        await subscribeTopics();
      }
    } catch (error) {
      this.error('MQTT connection setup failed:', error);
      throw error;
    }
  }

  /**
   * Register listeners for capabilities
   */
  registerListeners() {
    this.log('Registering capability listeners');

    this.registerCapabilityListener('mower_state', async (value) => {
      this.log('mower_state set to:', value);
      if (value === 'mowing') {
        await this.sendCommand('MOW');
      } else if (value === 'docked') {
        await this.sendCommand('PARK');
      } else if (value === 'paused') {
        await this.sendCommand('PAUSE');
      }
    });

    this.registerCapabilityListener('mower_eco_mode', async (value) => {
      this.log('mower_eco_mode set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`ECO_MODE ${payload}`);
    });

    this.registerCapabilityListener('mower_garage_enabled', async (value) => {
      this.log('mower_garage_enabled set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`GARAGE_ENABLED ${payload}`);
    });

    this.registerCapabilityListener('mower_radar_enabled', async (value) => {
      this.log('mower_radar_enabled set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`RADAR_ENABLED ${payload}`);
    });

    this.registerCapabilityListener('mower_frost_protection', async (value) => {
      this.log('mower_frost_protection set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`FROST_SENSOR ${payload}`);
    });

    this.registerCapabilityListener('mower_sensor_control', async (value) => {
      this.log('mower_sensor_control set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`SENSOR_CONTROL ${payload}`);
    });

    this.registerCapabilityListener('mower_spot_cut', async (value) => {
      this.log('mower_spot_cut set to:', value);
      if (value) {
        await this.sendCommand('SPOT_CUT');
      } else {
        await this.sendCommand('STOP_SPOT_CUT');
      }
    });
  }

  /**
   * Publishes command to the MQTT command topic
   */
  async sendCommand(command) {
    if (!this.client || !this.client.connected) {
      throw new Error('MQTT broker is not connected');
    }

    this.log(`Sending command: ${command} to ${this.commandTopic}`);
    await this.client.publish(this.commandTopic, command);
  }

  /**
   * Sets the override mow duration (minutes), updates the setting,
   * and publishes the new value to MQTT so the Python bridge picks it up.
   */
  async setMowDuration(minutes) {
    const seconds = minutes * 60;
    this.log(`setMowDuration: ${minutes} min (${seconds}s)`);

    // Persist in device settings
    this.setSetting('mow_duration', minutes);

    // Publish to MQTT so the bridge updates immediately
    if (this.client && this.client.connected) {
      await this.client.publish(
        `${this.settings.topic}/command`,
        `MOW_DURATION ${seconds}`,
      );
    }
  }

  /**
   * Migrates capabilities automatically, enforcing the exact order defined in the driver
   */
  async migrate() {
    try {
      this.log(`Checking capability migration/order for ${this.getName()}`);
      const targetCapabilities = this.driver.deviceCapabilities;

      if (!targetCapabilities) {
        this.error('No target capabilities defined on the driver, skipping migration.');
        return;
      }

      let isMigrating = false;
      let currentCapabilities = [...this.getCapabilities()];

      for (let index = 0; index < targetCapabilities.length; index++) {
        const targetCap = targetCapabilities[index];

        if (currentCapabilities[index] !== targetCap) {
          if (!isMigrating) {
            isMigrating = true;
            await this.setUnavailable('Device is migrating. Please wait!')
              .catch((err) => this.error('Failed to set device unavailable during migration:', err));
          }

          // Remove all capabilities from this index to the end
          const capLength = currentCapabilities.length;
          for (let i = index; i < capLength; i++) {
            const capToRemove = currentCapabilities[i];
            this.log(`Removing capability: ${capToRemove}`);
            await this.removeCapability(capToRemove)
              .catch((err) => this.error(`Failed to remove capability ${capToRemove}:`, err));
            await sleep(1000);
          }
          currentCapabilities = currentCapabilities.slice(0, index);

          // Add the target capability
          this.log(`Adding capability: ${targetCap}`);
          await this.addCapability(targetCap)
            .catch((err) => this.error(`Failed to add capability ${targetCap}:`, err));
          currentCapabilities.push(targetCap);
          await sleep(1000);
        }
      }

      // Also remove any extra capabilities if current list is longer than target list
      if (currentCapabilities.length > targetCapabilities.length) {
        const capLength = currentCapabilities.length;
        for (let i = targetCapabilities.length; i < capLength; i++) {
          const capToRemove = currentCapabilities[i];
          this.log(`Removing extra capability: ${capToRemove}`);
          await this.removeCapability(capToRemove)
            .catch((err) => this.error(`Failed to remove capability ${capToRemove}:`, err));
          await sleep(1000);
        }
      }

      if (isMigrating) {
        await this.setAvailable()
          .catch((err) => this.error('Failed to set device available after migration:', err));
      }
    } catch (error) {
      this.error('Capability migration failed:', error);
    }
  }

  /**
   * Triggers the collision alarm, and schedules a reset after 10 seconds
   */
  async triggerCollisionAlarm() {
    await this.setCapabilityValue('alarm_collision', true);
    this.collisionAlarmId = (this.collisionAlarmId || 0) + 1;
    const currentId = this.collisionAlarmId;

    await sleep(10000); // 10 seconds auto-reset

    if (this.collisionAlarmId === currentId) {
      this.log('Resetting collision alarm to false');
      await this.setCapabilityValue('alarm_collision', false);
    }
  }

  /**
   * Evaluates and updates device availability in Homey based on the MQTT bridge & mower states.
   */
  updateAvailability() {
    if (!this.client || !this.client.connected) {
      this.setUnavailable(this.homey.__('device.connectionError') || 'MQTT connection lost, reconnecting...').catch((err) => this.error(err));
      this.setCapabilityValue('alarm_connectivity', true).catch((err) => this.error(err));
      return;
    }

    if (this.bridgeOnline === undefined || this.mowerOnline === undefined) {
      // Don't flash unavailable immediately at startup while waiting for retained topics
      return;
    }

    if (this.bridgeOnline === false) {
      this.setUnavailable('Bridge is offline').catch((err) => this.error(err));
      this.setCapabilityValue('alarm_connectivity', true).catch((err) => this.error(err));
      return;
    }

    if (this.mowerOnline === false) {
      this.setUnavailable('Mower is disconnected').catch((err) => this.error(err));
      this.setCapabilityValue('alarm_connectivity', true).catch((err) => this.error(err));
      return;
    }

    // Both online and client is connected
    this.setAvailable().catch((err) => this.error(err));
    this.setCapabilityValue('alarm_connectivity', false).catch((err) => this.error(err));
  }

  /**
   * Helper to update a device setting
   */
  setSetting(key, value) {
    if (this.settings && this.settings[key] !== value) {
      this.settings[key] = value;
      this.log(`Updating setting ${key} to:`, value);
      this.setSettings({ [key]: value })
        .catch((err) => this.error(`Failed to update setting ${key}:`, err));
    }
  }

  async setSensorControlSensitivity(sensitivity) {
    this.log(`setSensorControlSensitivity: ${sensitivity}`);
    if (this.client && this.client.connected) {
      await this.client.publish(
        `${this.settings.topic}/command`,
        `SENSOR_CONTROL_SENSITIVITY ${sensitivity}`,
      );
    }
  }

  async setDrivePastWire(distance) {
    this.log(`setDrivePastWire: ${distance} mm`);
    await this.setSetting('drive_past_wire', distance);
    if (this.client && this.client.connected) {
      await this.client.publish(
        `${this.settings.topic}/command`,
        `DRIVE_PAST_WIRE ${distance}`,
      );
    }
  }

};

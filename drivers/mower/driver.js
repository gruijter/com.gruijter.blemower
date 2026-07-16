/*
 * com.gruijter.blemower driver.js
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
const MQTT = require('async-mqtt');

const sleep = promisify(setTimeout);

module.exports = class MyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.deviceCapabilities = [
      'mower_spot_cut',
      'mower_garage_enabled',
      'mower_radar_enabled',
      'mower_frost_protection',
      'mower_sensor_control',
      'mower_eco_mode',
      'mower_state',
      'mower_activity',
      'mower_state_text',
      'next_start_schedule',
      'mower_remaining_time',
      'mower_pitch',
      'mower_roll',
      'measure_battery',
      'measure_temperature',
      'measure_temperature.battery',
      'measure_voltage',
      'measure_current',
      'battery_charging_state',
      'mower_charging_cycles',
      'measure_signal_strength.loop',
      'measure_signal_strength',
      'mower_collisions',
      'mower_running_time',
      'mower_cutting_time',
      'mower_error',
      'alarm_collision',
      'alarm_lift',
      'alarm_upside_down',
      'alarm_safety',
      'alarm_stuck',
      'alarm_connectivity',
      'alarm_battery',
    ];

    this._registerFlowCards();
    this.log('Mower driver has been initialized');
  }

  /**
   * Register all flow card run listeners
   */
  _registerFlowCards() {
    // --- TRIGGERS ---

    // Fires when mower_state changes to a specific value (filtered by dropdown)
    this.homey.flow.getDeviceTriggerCard('mower_state_changed')
      .registerRunListener(async (args, state) => args.state === state.state);

    // Fires when mower_activity changes (unfiltered, activity passed as token)
    this.homey.flow.getDeviceTriggerCard('mower_activity_changed')
      .registerRunListener(async () => true);

    // Fires when a new mower error occurs (error != UNKNOWN)
    this.homey.flow.getDeviceTriggerCard('mower_error_occurred')
      .registerRunListener(async () => true);

    // --- CONDITIONS ---

    // Check if mower is in a specific state
    this.homey.flow.getConditionCard('mower_state_is')
      .registerRunListener(async (args) => {
        const currentState = args.device.getCapabilityValue('mower_state');
        return currentState === args.state;
      });

    // Check if mower activity matches a specific value
    this.homey.flow.getConditionCard('mower_activity_is')
      .registerRunListener(async (args) => {
        const currentActivity = args.device.getCapabilityValue('mower_activity');
        return currentActivity === args.activity;
      });

    // Check if remaining mow time is below the given number of minutes
    this.homey.flow.getConditionCard('mower_remaining_time_below')
      .registerRunListener(async (args) => {
        const remainingMins = args.device.getCapabilityValue('mower_remaining_time') || 0;
        return remainingMins < args.minutes;
      });

    // Custom boolean active conditions
    const booleanConditions = [
      'alarm_collision',
      'alarm_lift',
      'alarm_safety',
      'alarm_upside_down',
      'mower_spot_cut',
      'mower_eco_mode',
      'mower_frost_protection',
      'mower_garage_enabled',
      'mower_radar_enabled',
      'mower_sensor_control',
    ];
    for (const cap of booleanConditions) {
      this.homey.flow.getConditionCard(`${cap}_is_active`)
        .registerRunListener(async (args) => args.device.getCapabilityValue(cap) === true);
    }

    // Custom numeric below conditions
    const numericBelowConditions = [
      { id: 'mower_battery_temperature_below', cap: 'measure_temperature.battery', arg: 'temperature' },
      { id: 'mower_loop_signal_below', cap: 'measure_signal_strength.loop', arg: 'strength' },
      { id: 'mower_pitch_below', cap: 'mower_pitch', arg: 'angle' },
      { id: 'mower_roll_below', cap: 'mower_roll', arg: 'angle' },
      { id: 'mower_charging_cycles_below', cap: 'mower_charging_cycles', arg: 'cycles' },
      { id: 'mower_collisions_below', cap: 'mower_collisions', arg: 'collisions' },
      { id: 'mower_cutting_time_below', cap: 'mower_cutting_time', arg: 'hours' },
      { id: 'mower_running_time_below', cap: 'mower_running_time', arg: 'hours' },
    ];
    for (const item of numericBelowConditions) {
      this.homey.flow.getConditionCard(item.id)
        .registerRunListener(async (args) => {
          const val = args.device.getCapabilityValue(item.cap) || 0;
          return val < args[item.arg];
        });
    }

    // --- ACTIONS ---

    // Set override mow duration: update setting + publish to MQTT immediately
    this.homey.flow.getActionCard('set_mow_duration')
      .registerRunListener(async (args) => {
        const minutes = Math.round(args.minutes);
        if (minutes < 1 || minutes > 480) throw new Error('Duration must be between 1 and 480 minutes');
        await args.device.setMowDuration(minutes);
      });

    // Toggle actions for setable booleans
    const toggleActions = [
      { id: 'set_eco_mode', cap: 'mower_eco_mode' },
      { id: 'set_frost_protection', cap: 'mower_frost_protection' },
      { id: 'set_garage_enabled', cap: 'mower_garage_enabled' },
      { id: 'set_radar_enabled', cap: 'mower_radar_enabled' },
      { id: 'set_sensor_control', cap: 'mower_sensor_control' },
    ];
    for (const item of toggleActions) {
      this.homey.flow.getActionCard(item.id)
        .registerRunListener(async (args) => {
          await args.device.triggerCapabilityListener(item.cap, args.value);
        });
    }

    // Spot cut actions
    this.homey.flow.getActionCard('start_spot_cut')
      .registerRunListener(async (args) => {
        await args.device.triggerCapabilityListener('mower_spot_cut', true);
      });

    this.homey.flow.getActionCard('stop_spot_cut')
      .registerRunListener(async (args) => {
        await args.device.triggerCapabilityListener('mower_spot_cut', false);
      });

    // SensorControl sensitivity action
    this.homey.flow.getActionCard('set_sensor_control_sensitivity')
      .registerRunListener(async (args) => {
        await args.device.setSensorControlSensitivity(args.sensitivity);
      });

    // Drive past wire action
    this.homey.flow.getActionCard('set_drive_past_wire')
      .registerRunListener(async (args) => {
        await args.device.setDrivePastWire(args.distance);
      });

    // Generate loop signal action
    this.homey.flow.getActionCard('generate_loop_signal')
      .registerRunListener(async (args) => {
        await args.device.sendCommand('GENERATE_LOOP_SIGNAL');
      });
  }

  /**
   * onPair is called when a user is pairing a device.
   */
  async onPair(session) {
    let discovered = [];

    session.setHandler('mqtt_login', async (mqttSettings) => {
      try {
        this.log('[onPair] mqtt_login triggered for host:', mqttSettings.host);

        // Connect to verify
        const client = await this.connectMQTT(mqttSettings);

        // Try to get actual device info from status topic
        const mowers = {};
        const statusTopicWildcard = `${mqttSettings.topic}/+/status`;

        const messageListener = (topic, message) => {
          if (topic.startsWith(`${mqttSettings.topic}/`) && topic.endsWith('/status')) {
            const subPath = topic.substring(mqttSettings.topic.length + 1);
            const mac = subPath.substring(0, subPath.indexOf('/status'));
            if (/^[0-9a-fA-F]{2}(_[0-9a-fA-F]{2}){5}$/.test(mac)) {
              try {
                const mowerData = JSON.parse(message.toString());
                mowers[mac] = mowerData;
                this.log(`[onPair] Discovered mower: ${mac}`, mowerData);
              } catch (e) {
                this.error(`[onPair] Failed to parse status JSON for ${mac}:`, e.message);
              }
            }
          }
        };

        client.on('message', messageListener);
        await client.subscribe(statusTopicWildcard);

        // Wait 3 seconds for retained status messages to arrive
        for (let i = 0; i < 30; i++) {
          await sleep(100);
        }

        // Clean up
        try {
          await client.unsubscribe(statusTopicWildcard);
          client.removeListener('message', messageListener);
          await client.end();
        } catch (cleanupError) {
          this.error('[onPair] Cleanup error:', cleanupError.message);
        }

        const macs = Object.keys(mowers);
        if (macs.length === 0) {
          throw new Error('No mowers found. Make sure the python bridge is running and has published a status.');
        }

        discovered = macs.map((mac) => {
          const mowerData = mowers[mac];
          let mowerName = `Mower ${mac}`;
          if (mowerData) {
            if (mowerData.MowerName) {
              mowerName = mowerData.MowerName;
            } else if (mowerData.Model) {
              mowerName = mowerData.Model;
            }
          }
          const serialNumber = mowerData && mowerData.SerialNumber ? mowerData.SerialNumber : `mower-${mac}`;

          const settings = {
            ...mqttSettings,
            manufacturer: mowerData && mowerData.Manufacturer ? mowerData.Manufacturer : 'Unknown',
            model: mowerData && mowerData.Model ? mowerData.Model : 'Unknown',
            serialNumber,
            schedule: mowerData && mowerData.Schedule ? mowerData.Schedule : '-',
            // Set topic to the specific subtopic for this mower (base_topic/mac)
            topic: `${mqttSettings.topic}/${mac}`,
          };

          return {
            name: mowerName,
            data: {
              id: serialNumber,
            },
            settings,
          };
        });

        this.log('[onPair] Returning success, found:', discovered);
        return { success: true };
      } catch (error) {
        this.error('[onPair] mqtt_login caught exception:', error.message, error.stack);
        throw new Error(`Failed to discover mowers: ${error.message}`);
      }
    });

    session.setHandler('list_devices', async () => discovered);
  }

  /**
   * Helper to return a connected MQTT client
   */
  async connectMQTT(mqttSettings) {
    try {
      if (!mqttSettings) throw new Error('mqttSettings are required');
      const protocol = mqttSettings.tls ? 'mqtts' : 'mqtt';
      const host = `${protocol}://${mqttSettings.host}:${mqttSettings.port}`;
      const options = {
        clientId: `Homey_${Math.random().toString(16).substring(2, 8)}`,
        username: mqttSettings.username || undefined,
        password: mqttSettings.password || undefined,
        rejectUnauthorized: false,
        keepalive: 60,
        reconnectPeriod: 10000,
        clean: true,
        queueQoSZero: false,
      };
      const mqttClient = await MQTT.connectAsync(host, options);
      return mqttClient;
    } catch (error) {
      this.error('MQTT connection error:', error);
      throw error;
    }
  }

};

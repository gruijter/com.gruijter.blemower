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
const {
  SCHEDULE_SETTING_KEYS,
  SCHEDULE_WRITE_GRACE_MS,
  parseTimeToMinutes,
  minutesToHHMM,
  buildWeekTasksFromSettings,
  scheduleTasksToWeekFields,
  normalizeTasks,
} = require('../../lib/schedule');

const sleep = promisify(setTimeout);

// Status JSON fields used by assertFieldSupported() to detect whether the bridge is
// running a version new enough to understand the corresponding command. Only fields
// that were introduced after the app's initial release are listed here — a command
// with no matching field (MOW/PARK/PAUSE, RESET_BLADE_USAGE, GENERATE_LOOP_SIGNAL) has
// no reliable signal to check and is intentionally left unguarded.
const FEATURE_STATUS_FIELDS = [
  'ecoMode',
  'garageEnabled',
  'radarEnabled',
  'frostSensorEnabled',
  'sensorControlEnabled',
  'sensorControlSensitivity',
  'drivePastWire',
  'reversingDistance',
  'spotCuttingState',
  'customMowDuration',
  'ScheduleTasks',
];
// MowPending is deliberately NOT in the list above. It arrived with bridge v1.6.0, but
// there is no v1.6.0-only command to guard with it — MOW has always worked. It is used
// directly (see the mower_state listener) to refuse a second, pointless MOW, and stays
// undefined on an older bridge so that command keeps going through unchanged.

// A timestamp older than this is treated as "the mower has no value for this", not as a
// real time in the past: mowers report 0 for an unset schedule, which older bridges
// forwarded as 1970-01-01.
const NO_VALUE_BEFORE_MS = Date.UTC(2000, 0, 1);

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
      // Status JSON fields actually seen from the bridge at least once, persisted so it
      // survives restarts. A command whose feature was added to the bridge after the
      // user's currently-running bridge version never has its field appear at all, so
      // that field stays unseen and guards the corresponding write from silently
      // no-opping on the real mower (see assertFieldSupported()).
      this.seenStatusFields = new Set(this.getStoreValue('seenStatusFields') || []);

      await this.initTimezone();
      await this.migrate();
      // Seed from the capability so an app restart during a pending mow doesn't re-fire
      // mow_deferred. Stays false until the first v1.6.0+ status arrives, which is also
      // the correct value for an older bridge that can never report it.
      this._mowPending = !!this.getCapabilityValue('mower_mow_pending');
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
      this.assertFieldSupported('customMowDuration');
      const seconds = newSettings.mow_duration * 60;
      this.log(`Publishing new custom mow duration: ${seconds} seconds`);
      this.client.publishAsync(`${this.settings.topic}/command`, `MOW_DURATION ${seconds}`)
        .catch((err) => this.error('Failed to publish custom mow duration:', err));
    }

    if (changedKeys.includes('drive_past_wire') && this.client && this.client.connected) {
      this.assertFieldSupported('drivePastWire');
      this.log(`Publishing new drive past wire distance: ${newSettings.drive_past_wire} mm`);
      this.client.publishAsync(`${this.settings.topic}/command`, `DRIVE_PAST_WIRE ${newSettings.drive_past_wire}`)
        .catch((err) => this.error('Failed to publish drive past wire:', err));
    }

    if (changedKeys.includes('reversing_distance') && this.client && this.client.connected) {
      this.assertFieldSupported('reversingDistance');
      this.log(`Publishing new reversing distance: ${newSettings.reversing_distance} mm`);
      this.client.publishAsync(`${this.settings.topic}/command`, `REVERSING_DISTANCE ${newSettings.reversing_distance}`)
        .catch((err) => this.error('Failed to publish reversing distance:', err));
    }

    if (changedKeys.some((key) => SCHEDULE_SETTING_KEYS.includes(key))) {
      // Throwing here blocks the settings save and shows the message to the user.
      this.assertFieldSupported('ScheduleTasks');
      let tasks;
      try {
        tasks = buildWeekTasksFromSettings(newSettings);
      } catch (err) {
        throw new Error(`Invalid weekly schedule: ${err.message}`);
      }
      this.writeWeekSchedule(tasks)
        .catch((err) => this.error('Failed to publish weekly schedule:', err));
    }
  }

  /**
   * Throws if the bridge has never sent the given status field, meaning it predates
   * the feature that field represents. Writing to an unsupported feature would
   * otherwise appear to succeed in Homey (settings saved, flow ran fine) while
   * silently doing nothing on the real mower, with no way to ever detect or correct
   * the mismatch (sendCommand() is fire-and-forget and the bridge never acks).
   */
  assertFieldSupported(field) {
    if (!this.seenStatusFields.has(field)) {
      throw new Error(this.homey.__('device.notSupportedByBridge'));
    }
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
    if (this.client) {
      try {
        await this.client.endAsync();
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
        await this.client.endAsync();
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
        await this.client.endAsync();
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
        await this.client.endAsync();
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

          // Track which version-gated status fields this bridge actually sends, so
          // assertFieldSupported() can tell a genuinely unsupported command apart from
          // one that would work fine. Fields present since the very first bridge version
          // (Battery, State, Activity, ...) aren't tracked — there's nothing to gain by
          // guarding commands that have always worked.
          FEATURE_STATUS_FIELDS.forEach((field) => {
            if (data[field] !== undefined && !this.seenStatusFields.has(field)) {
              this.seenStatusFields.add(field);
              this.setStoreValue('seenStatusFields', [...this.seenStatusFields])
                .catch((err) => this.error('Failed to persist seenStatusFields:', err));
            }
          });

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

          // Update mower_state (picker: "mowing", "docked", "paused", "error").
          // Mapped from Activity, the only field that says what the mower is actually
          // doing; State only decides error/safety above. There is deliberately no
          // State === 'IN_OPERATION' catch-all any more: it reported "mowing" for every
          // activity not listed here, so a forced mow that is still topping up its
          // battery in the dock (State IN_OPERATION, Activity CHARGING) showed as
          // "Mowing" while the mower sat motionless. Anything not explicitly mowing or
          // docked (NONE, STOPPED_IN_GARDEN, PAUSED, an activity a future firmware adds)
          // falls back to 'paused' rather than claiming the mower is cutting grass.
          //
          // A pending mow reports 'paused', not 'docked', even though the mower is
          // physically in the dock. Two reasons, and the second is the important one:
          //  - 'docked' is indistinguishable from ordinary idle charging, while a queued
          //    job that has not started is much closer to "paused" than to "parked".
          //  - the picker is also the control. PARK (= SetOverrideParkUntilNextStart on
          //    the bridge) is what actually cancels a forced mow, and it is only reachable
          //    by selecting 'docked' — which the user cannot do while 'docked' is already
          //    the current value. Reporting 'paused' keeps that abort available.
          // Ordinary charging with nothing queued still reports 'docked', and on a bridge
          // older than v1.6.0 mowPending is always false, so nothing changes there.
          const mowPending = data.MowPending === true;
          let mowerState = 'paused';
          if (safetyStop || hasError) {
            mowerState = 'error';
          } else if (currentActivity === 'MOWING' || currentActivity === 'GOING_OUT') {
            mowerState = 'mowing';
          } else if (mowPending) {
            mowerState = 'paused';
          } else if (currentActivity === 'CHARGING' || currentActivity === 'PARKED' || currentActivity === 'GOING_HOME') {
            mowerState = 'docked';
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

          // Update next_start_schedule (formatted string in Homey local timezone, e.g. "Jul 07 15:00").
          // Three distinct cases, deliberately kept apart:
          //  - no next start at all: bridge >= v1.6.0 sends null, older bridges sent the
          //    1970 sentinel (the mower reports 0 while an override runs). Clear it, or a
          //    stale time keeps sitting on screen claiming a start that will never come.
          //  - a real, still-future start: show it.
          //  - a real start that has just passed: leave the current value alone, the mower
          //    simply hasn't refreshed it yet and the old time is still the best guess.
          if (data.NextStartSchedule !== undefined) {
            try {
              const rawDate = data.NextStartSchedule === null ? null : new Date(data.NextStartSchedule);
              const hasNextStart = rawDate !== null && !Number.isNaN(rawDate.getTime())
                && rawDate.getTime() >= NO_VALUE_BEFORE_MS;
              if (!hasNextStart) {
                this.setCapabilityValue('next_start_schedule', null).catch((err) => this.error(err));
              } else if (rawDate.getTime() > Date.now() - 60000) {
                const formatted = await this.formatLocalTime(rawDate);
                this.setCapabilityValue('next_start_schedule', formatted).catch((err) => this.error(err));
              }
            } catch (err) {
              this.error('Failed to parse NextStartSchedule:', err);
            }
          }

          // Update mower_mow_pending: a forced mow the mower accepted but has not acted
          // on yet, because it is finishing its charge in the dock first. MowPending is
          // absent on bridges older than v1.6.0 — leave the capability and the pending
          // state untouched there, so nothing changes versus the previous release.
          if (data.MowPending !== undefined) {
            let startsAt = data.MowStartsAt ? new Date(data.MowStartsAt) : null;
            if (startsAt !== null && Number.isNaN(startsAt.getTime())) startsAt = null;

            let pendingText = null;
            if (mowPending) {
              // Not every mower reports a charging estimate, so MowStartsAt can legitimately
              // be null while a mow is genuinely pending.
              pendingText = startsAt
                ? await this.formatLocalTime(startsAt)
                : this.homey.__('device.mowPendingCharging');
            }
            this.setCapabilityValue('mower_mow_pending', pendingText).catch((err) => this.error(err));

            const wasPending = this._mowPending;
            this._mowPending = mowPending;
            if (mowPending && !wasPending) {
              this.triggerMowDeferred(data, pendingText, startsAt)
                .catch((err) => this.error('mow_deferred trigger error:', err));
            }
          }

          // Update mower_remaining_charge_time (minutes). The bridge only sends
          // remainingChargingTime while charging, and only for mowers that report a usable
          // estimate; MowPending tells the two "no value" reasons apart — absent means an
          // old bridge (leave the capability alone), present means a v1.6.0+ bridge with
          // nothing to report right now (null, so the tile shows no value at all rather
          // than a misleading 0 minutes).
          if (data.remainingChargingTime !== undefined) {
            const chargeSecs = Number(data.remainingChargingTime);
            if (!Number.isNaN(chargeSecs)) {
              this.setCapabilityValue('mower_remaining_charge_time', Math.round(chargeSecs / 60)).catch((err) => this.error(err));
            }
          } else if (data.MowPending !== undefined) {
            this.setCapabilityValue('mower_remaining_charge_time', null).catch((err) => this.error(err));
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
          // Sync the schedule_<weekday> settings fields from the fetched ScheduleTasks,
          // unless a Homey-initiated write is still pending confirmation (avoids a stale
          // fetch, in flight before the write, clobbering what was just saved). If the
          // pending write hasn't been confirmed within SCHEDULE_WRITE_GRACE_MS, assume it
          // was overtaken (e.g. changed from the official app) and trust the fetch again.
          if (Array.isArray(data.ScheduleTasks)) {
            const pending = this._pendingScheduleWrite;
            const incomingKey = normalizeTasks(data.ScheduleTasks);
            const isPendingConfirmed = pending && incomingKey === pending.key;
            const isPendingExpired = pending && (Date.now() - pending.since) > SCHEDULE_WRITE_GRACE_MS;

            if (!pending || isPendingConfirmed || isPendingExpired) {
              if (pending) this._pendingScheduleWrite = null;
              const fields = scheduleTasksToWeekFields(data.ScheduleTasks);
              const changed = {};
              Object.keys(fields).forEach((key) => {
                if (this.settings[key] !== fields[key]) changed[key] = fields[key];
              });
              if (Object.keys(changed).length) {
                Object.assign(this.settings, changed);
                this.setSettings(changed).catch((err) => this.error('Failed to sync schedule settings from device:', err));
              }
            }
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
          await this.client.subscribeAsync(this.statusTopic);

          const availabilityTopic = `${this.settings.topic}/availability`;
          this.log(`Subscribing to ${availabilityTopic}`);
          await this.client.subscribeAsync(availabilityTopic);

          const mowerTopic = `${this.settings.topic}/mower`;
          this.log(`Subscribing to ${mowerTopic}`);
          await this.client.subscribeAsync(mowerTopic);

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
        // A forced mow is already queued and the mower is finishing its charge first.
        // Sending MOW again does nothing observable, so say so (Homey shows this as a
        // toast) instead of letting the user assume the second press had an effect.
        // Only guards when the bridge actually reports MowPending — on an older bridge
        // it stays undefined and the command goes through exactly as before.
        if (this._mowPending === true) {
          throw new Error(this.homey.__('device.mowAlreadyPending'));
        }
        await this.sendCommand('MOW');
      } else if (value === 'docked') {
        await this.sendCommand('PARK');
      } else if (value === 'paused') {
        await this.sendCommand('PAUSE');
      }
    });

    this.registerCapabilityListener('mower_eco_mode', async (value) => {
      this.assertFieldSupported('ecoMode');
      this.log('mower_eco_mode set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`ECO_MODE ${payload}`);
    });

    this.registerCapabilityListener('mower_garage_enabled', async (value) => {
      this.assertFieldSupported('garageEnabled');
      this.log('mower_garage_enabled set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`GARAGE_ENABLED ${payload}`);
    });

    this.registerCapabilityListener('mower_radar_enabled', async (value) => {
      this.assertFieldSupported('radarEnabled');
      this.log('mower_radar_enabled set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`RADAR_ENABLED ${payload}`);
    });

    this.registerCapabilityListener('mower_frost_protection', async (value) => {
      this.assertFieldSupported('frostSensorEnabled');
      this.log('mower_frost_protection set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`FROST_SENSOR ${payload}`);
    });

    this.registerCapabilityListener('mower_sensor_control', async (value) => {
      this.assertFieldSupported('sensorControlEnabled');
      this.log('mower_sensor_control set to:', value);
      const payload = value ? 'ON' : 'OFF';
      await this.sendCommand(`SENSOR_CONTROL ${payload}`);
    });

    this.registerCapabilityListener('mower_spot_cut', async (value) => {
      this.assertFieldSupported('spotCuttingState');
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
    await this.client.publishAsync(this.commandTopic, command);
  }

  /**
   * Sets the override mow duration (minutes), updates the setting,
   * and publishes the new value to MQTT so the Python bridge picks it up.
   */
  async setMowDuration(minutes) {
    this.assertFieldSupported('customMowDuration');
    const seconds = minutes * 60;
    this.log(`setMowDuration: ${minutes} min (${seconds}s)`);

    // Persist in device settings
    this.setSetting('mow_duration', minutes);

    // Publish to MQTT so the bridge updates immediately
    if (this.client && this.client.connected) {
      await this.client.publishAsync(
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
    this.assertFieldSupported('sensorControlSensitivity');
    this.log(`setSensorControlSensitivity: ${sensitivity}`);
    if (this.client && this.client.connected) {
      await this.client.publishAsync(
        `${this.settings.topic}/command`,
        `SENSOR_CONTROL_SENSITIVITY ${sensitivity}`,
      );
    }
  }

  async setDrivePastWire(distance) {
    this.assertFieldSupported('drivePastWire');
    this.log(`setDrivePastWire: ${distance} mm`);
    await this.setSetting('drive_past_wire', distance);
    if (this.client && this.client.connected) {
      await this.client.publishAsync(
        `${this.settings.topic}/command`,
        `DRIVE_PAST_WIRE ${distance}`,
      );
    }
  }

  /**
   * Writes a full weekly schedule (array of {days, start, duration_minutes} tasks)
   * to the mower: arms the pending-write guard (so a stale fetched status doesn't
   * clobber this write before the bridge's confirmation arrives, see the
   * ScheduleTasks handling in connectMQTT()), optimistically reflects the result
   * in the schedule_<weekday> settings fields, then publishes SET_SCHEDULE (or
   * CLEAR_SCHEDULE when the task list is empty).
   */
  async writeWeekSchedule(tasks) {
    this._pendingScheduleWrite = { key: normalizeTasks(tasks), since: Date.now() };
    const fields = scheduleTasksToWeekFields(tasks);
    Object.assign(this.settings, fields);
    this.setSettings(fields).catch((err) => this.error('Failed to optimistically update schedule settings:', err));

    const payload = tasks.length ? `SET_SCHEDULE ${JSON.stringify(tasks)}` : 'CLEAR_SCHEDULE';
    await this.sendCommand(payload);
  }

  /**
   * Flow action handler for set_week_schedule: applies a single time range to the
   * selected days, overwriting the entire weekly schedule (see the flow card hint).
   */
  async setWeekScheduleFromFlow(days, fromRaw, toRaw) {
    this.assertFieldSupported('ScheduleTasks');
    if (!Array.isArray(days) || !days.length) {
      throw new Error('Select at least one day');
    }
    const start = parseTimeToMinutes(fromRaw);
    const end = parseTimeToMinutes(toRaw);
    if (start === null) throw new Error(`Invalid "from" time: "${fromRaw}". Use 24h HH:MM, e.g. 09:00`);
    if (end === null) throw new Error(`Invalid "to" time: "${toRaw}". Use 24h HH:MM, e.g. 11:00`);
    if (end <= start) throw new Error('"to" time must be after "from" time');

    const task = {
      days: [...days],
      start: minutesToHHMM(start),
      duration_minutes: end - start,
    };
    await this.writeWeekSchedule([task]);
  }

  /**
   * Formats a Date as "Mon DD HH:MM" in the Homey local timezone, rounded to the
   * nearest minute (e.g. 12:59:41 UTC -> "Jul 07 13:00"). Shared by
   * next_start_schedule, mower_mow_pending and the mow_deferred flow tokens so every
   * time the app shows reads identically.
   */
  async formatLocalTime(date) {
    const rounded = new Date(Math.round(date.getTime() / 60000) * 60000);

    let timeZone = this.timezone;
    if (!timeZone && this.homey.clock && typeof this.homey.clock.getTimezone === 'function') {
      try {
        timeZone = await this.homey.clock.getTimezone();
      } catch (e) {
        timeZone = 'UTC';
      }
    }

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(rounded);

    const partMap = {};
    for (const p of parts) {
      partMap[p.type] = p.value;
    }

    return `${partMap.month} ${partMap.day} ${partMap.hour}:${partMap.minute}`;
  }

  /**
   * Fires the mow_deferred trigger for a forced mow that is queued behind a charge.
   * The override window starts the moment the command is sent, not when the mower
   * leaves the dock, so the wait is taken straight out of the requested mowing time:
   * a one-hour override issued at 17:40 that only starts mowing at 18:31 still ends at
   * 18:40, leaving 9 minutes of actual cutting. Both halves are exposed as tokens so a
   * flow can react (notify, or extend the duration) instead of the user finding out
   * afterwards.
   */
  async triggerMowDeferred(data, pendingText, startsAt) {
    const tokens = {
      starts_at: pendingText,
      override_ends_at: '',
      delay_minutes: 0,
      mow_minutes_left: 0,
    };

    const overrideStart = data.OverrideStartSchedule ? new Date(data.OverrideStartSchedule) : null;
    const overrideDuration = Number(data.OverrideDuration);
    const hasOverride = overrideStart !== null && !Number.isNaN(overrideStart.getTime())
      && !Number.isNaN(overrideDuration) && overrideDuration > 0;
    const overrideEnd = hasOverride ? new Date(overrideStart.getTime() + (overrideDuration * 1000)) : null;

    if (overrideEnd) tokens.override_ends_at = await this.formatLocalTime(overrideEnd);

    // Without a charging estimate the delay is unknown, so report the whole remaining
    // override window as mowing time rather than inventing a start moment.
    const mowingFrom = startsAt ? startsAt.getTime() : Date.now();
    if (startsAt) tokens.delay_minutes = Math.max(0, Math.round((startsAt.getTime() - Date.now()) / 60000));
    if (overrideEnd) tokens.mow_minutes_left = Math.max(0, Math.round((overrideEnd.getTime() - mowingFrom) / 60000));

    this.log(`Mow deferred: starts at ${tokens.starts_at}, override ends ${tokens.override_ends_at || 'unknown'}, `
      + `${tokens.delay_minutes} min charging first, ${tokens.mow_minutes_left} min mowing left`);

    await this.driver.homey.flow.getDeviceTriggerCard('mow_deferred').trigger(this, tokens, {});
  }

  /**
   * Asynchronously fetches and caches the Homey configured timezone
   */
  async initTimezone() {
    try {
      if (this.homey.clock && typeof this.homey.clock.getTimezone === 'function') {
        this.timezone = await this.homey.clock.getTimezone();
        this.log(`Device retrieved Homey timezone: ${this.timezone}`);
        this.homey.clock.on('timezoneChange', (tz) => {
          this.log(`Homey timezone updated to: ${tz}`);
          this.timezone = tz;
        });
      }
    } catch (err) {
      this.error('Failed to initialize Homey timezone:', err);
      this.timezone = 'UTC';
    }
  }

};

/*
 * com.gruijter.blemower DeviceMigrator.js
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

const sleep = promisify(setTimeout);

module.exports = {
  // Repairs a device's capability list (existence + order) against `correctCaps`,
  // restoring each surviving capability's previous value. Returns whether it actually
  // touched the list.
  // Snapshots the capability list once and does a single removal pass + single
  // addition pass — re-deriving the mismatch from device.getCapabilities() after every
  // change doesn't reflect this same function's own removeCapability()/addCapability()
  // calls as they happen, turning an O(n) migration into O(n^2) round trips.
  async migrateCapabilities(device, correctCaps) {
    device.log(`checking device migration for ${device.getName()}`);

    const caps = device.getCapabilities();
    const state = {};
    caps.forEach((cap) => {
      state[cap] = device.getCapabilityValue(cap);
    });

    const maxLen = Math.max(caps.length, correctCaps.length);
    let firstMismatch = -1;
    for (let index = 0; index < maxLen; index += 1) {
      if (caps[index] !== correctCaps[index]) {
        firstMismatch = index;
        break;
      }
    }
    if (firstMismatch === -1) return false;

    device.setUnavailable(device.homey.__('device.migrating')).catch((error) => device.error(error));

    // remove all caps from the first mismatch onward — also covers extra trailing
    // caps not present in correctCaps at all
    for (let i = firstMismatch; i < caps.length; i += 1) {
      if (device.hasCapability(caps[i])) {
        device.log(`removing capability ${caps[i]} for ${device.getName()}`);
        await device.removeCapability(caps[i]).catch((error) => device.error(error));
        await sleep(2 * 1000); // wait a bit for Homey to settle
      }
    }

    for (let index = firstMismatch; index < correctCaps.length; index += 1) {
      const newCap = correctCaps[index];
      if (!device.hasCapability(newCap)) {
        device.log(`adding capability ${newCap} for ${device.getName()}`);
        await device.addCapability(newCap).catch((error) => device.error(error));
      }
      if (state[newCap] !== undefined && state[newCap] !== null) {
        device.log(`${device.getName()} restoring value ${newCap} to ${state[newCap]}`);
        await device.setCapabilityValue(newCap, state[newCap]).catch((error) => device.error(error));
      }
      await sleep(2 * 1000); // wait a bit for Homey to settle
    }
    return true;
  },
};

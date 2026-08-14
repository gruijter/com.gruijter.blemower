/*
 * com.gruijter.blemower lib/schedule.js
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

// Shared weekly-schedule helpers used by both the driver (pairing) and the
// device (settings sync, onSettings write, flow action). Task shape matches
// the bridge's SET_SCHEDULE payload / ScheduleTasks status field exactly:
// {days: ["mon", ...], start: "HH:MM", duration_minutes: N}.

const WEEKDAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAY_ABBR = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SCHEDULE_SETTING_KEYS = WEEKDAY_KEYS.map((day) => `schedule_${day}`);
// How long to trust local (Homey-written) schedule settings over a freshly fetched
// ScheduleTasks status that doesn't match yet — covers the gap between publishing
// SET_SCHEDULE/CLEAR_SCHEDULE and the bridge's write-triggered re-fetch landing on
// the next status poll (bridge default poll interval is 60s).
const SCHEDULE_WRITE_GRACE_MS = 90 * 1000;

/**
 * Parses a single "HH:MM" (or "H.MM") time string into minutes since midnight.
 * Returns null if the string isn't a valid 24h time.
 */
function parseTimeToMinutes(raw) {
  const match = String(raw).trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function minutesToHHMM(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Parses a settings field value like "10:00-11:00,15:00-16:30" into a list of
 * {startMinutes, durationMinutes}. Forgiving on separators: ',' or ';' between
 * ranges, '-'/'–'/'—'/'~'/'to' between start and end time. Throws with a
 * human-readable message on invalid input.
 */
function parseDayRanges(fieldValue) {
  const value = String(fieldValue || '').trim();
  if (!value) return [];
  const entries = value.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  return entries.map((entry) => {
    const parts = entry.split(/\s*(?:-|–|—|~|to)\s*/i).filter(Boolean);
    if (parts.length !== 2) {
      throw new Error(`invalid range "${entry}" (expected e.g. 10:00-11:00)`);
    }
    const start = parseTimeToMinutes(parts[0]);
    const end = parseTimeToMinutes(parts[1]);
    if (start === null || end === null) {
      throw new Error(`invalid time in "${entry}" (use 24h HH:MM)`);
    }
    if (end <= start) {
      throw new Error(`end time must be after start time in "${entry}"`);
    }
    return { startMinutes: start, durationMinutes: end - start };
  });
}

/**
 * Builds the full SET_SCHEDULE task array (one task per day+range) from the
 * 7 schedule_<weekday> settings fields. Throws an aggregated error listing
 * every invalid day if any field fails to parse.
 */
function buildWeekTasksFromSettings(settingsObj) {
  const tasks = [];
  const errors = [];
  WEEKDAY_KEYS.forEach((day, idx) => {
    const raw = settingsObj[`schedule_${day}`];
    try {
      const ranges = parseDayRanges(raw);
      ranges.forEach(({ startMinutes, durationMinutes }) => {
        tasks.push({
          days: [WEEKDAY_ABBR[idx]],
          start: minutesToHHMM(startMinutes),
          duration_minutes: durationMinutes,
        });
      });
    } catch (err) {
      errors.push(`${day}: ${err.message}`);
    }
  });
  if (errors.length) throw new Error(errors.join('; '));
  return tasks;
}

/**
 * Converts a ScheduleTasks array (bridge's structured schedule, same shape
 * SET_SCHEDULE accepts) into the 7 schedule_<weekday> settings field values.
 */
function scheduleTasksToWeekFields(tasks) {
  const perDay = {};
  WEEKDAY_ABBR.forEach((abbr) => {
    perDay[abbr] = [];
  });
  (tasks || []).forEach((task) => {
    const start = parseTimeToMinutes(task.start);
    if (start === null) return;
    const end = start + Number(task.duration_minutes || 0);
    const range = `${minutesToHHMM(start)}-${minutesToHHMM(end)}`;
    (task.days || []).forEach((abbr) => {
      if (perDay[abbr]) perDay[abbr].push({ start, range });
    });
  });
  const fields = {};
  WEEKDAY_KEYS.forEach((day, idx) => {
    const abbr = WEEKDAY_ABBR[idx];
    fields[`schedule_${day}`] = perDay[abbr]
      .sort((a, b) => a.start - b.start)
      .map((r) => r.range)
      .join(',');
  });
  return fields;
}

/**
 * Canonical JSON representation of a task list, used to check whether a
 * freshly fetched ScheduleTasks matches what Homey last wrote.
 */
function normalizeTasks(tasks) {
  const normalized = (tasks || [])
    .map((t) => ({
      days: [...(t.days || [])].sort(),
      start: t.start,
      duration_minutes: Number(t.duration_minutes),
    }))
    .sort((a, b) => (a.start + a.days.join()).localeCompare(b.start + b.days.join()));
  return JSON.stringify(normalized);
}

module.exports = {
  WEEKDAY_KEYS,
  WEEKDAY_ABBR,
  SCHEDULE_SETTING_KEYS,
  SCHEDULE_WRITE_GRACE_MS,
  parseTimeToMinutes,
  minutesToHHMM,
  parseDayRanges,
  buildWeekTasksFromSettings,
  scheduleTasksToWeekFields,
  normalizeTasks,
};

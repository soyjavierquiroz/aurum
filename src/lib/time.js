import { DateTime } from 'luxon';

// Ventana laboral por defecto: Lun-Dom 09:00-22:00
export function nextWorkingMoment(dt, tz = process.env.DEFAULT_TIMEZONE || 'America/La_Paz') {
  let cur = (dt ? DateTime.fromJSDate(dt) : DateTime.now()).setZone(tz);
  const isWorkingHour = (d) => d.hour >= 9 && d.hour < 22;
  if (isWorkingHour(cur)) return cur;
  if (cur.hour >= 22) {
    return cur.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  }
  if (cur.hour < 9) {
    return cur.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  }
  return cur;
}

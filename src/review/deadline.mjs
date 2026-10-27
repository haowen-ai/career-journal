export function validTimezone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  if (zone === 'Z') return true;
  if (/^[+-]\d\d:\d\d$/.test(zone)) return Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) < 60;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

export function quotedClock(quote, time, zone, date) {
  if (!validTimezone(zone) || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time ?? '')) return false;
  const [hour, minute, second] = time.split(':').map(Number);
  const clocks = [...quote.matchAll(/\b(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*([ap]\.?m\.?)?\b/gi)];
  const clockOk = clocks.some(([, h, m, s, period]) => {
    if (m === undefined && !period) return false;
    let candidate = Number(h);
    if (period) { if (candidate < 1 || candidate > 12) return false; candidate = candidate % 12 + (/^p/i.test(period) ? 12 : 0); }
    return candidate === hour && Number(m ?? 0) === minute && Number(s ?? 0) === (second ?? 0);
  });
  if (!clockOk) return false;
  const names = [zone];
  if (zone === 'Z') names.push('UTC', 'GMT');
  else if (!/^[+-]/.test(zone)) {
    for (const style of ['short', 'long']) {
      const name = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: style })
        .formatToParts(new Date(`${date}T12:00:00Z`)).find((part) => part.type === 'timeZoneName')?.value;
      if (name) names.push(name);
    }
  }
  return names.some((name) => new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i').test(quote));
}

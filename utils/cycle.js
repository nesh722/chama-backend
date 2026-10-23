function pad(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Weekly groups: label is the date the current 7-day cycle started, counted from the
// group's anchor (creation) date. Monthly groups: calendar month, 'YYYY-MM'.
function getCurrentCycleLabel(frequency, anchorDate = null) {
  const now = new Date();

  if (frequency === 'weekly') {
    if (anchorDate) {
      const anchor = new Date(anchorDate);
      anchor.setHours(0, 0, 0, 0);
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);

      const days = Math.round((today - anchor) / 86400000);
      const index = Math.max(Math.floor(days / 7), 0);

      const start = new Date(anchor);
      start.setDate(anchor.getDate() + index * 7);
      return formatLocalDate(start);
    }

    // Fallback for a group with no anchor date: old calendar-week label
    const target = new Date(now.valueOf());
    const dayNr = (now.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3) / 7);
    return `${target.getUTCFullYear()}-W${pad(week)}`;
  }

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Readable cycle name for notification text: 'October 2026' or 'the week of Oct 16, 2026'
function describeCycle(cycle) {
  const monthly = /^(\d{4})-(\d{2})$/.exec(cycle);
  if (monthly) return `${MONTHS[Number(monthly[2]) - 1]} ${monthly[1]}`;
  const weekly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cycle);
  if (weekly) return `the week of ${MONTHS[Number(weekly[2]) - 1].slice(0, 3)} ${Number(weekly[3])}, ${weekly[1]}`;
  return cycle;
}

// How far through a cycle we are. Returns null for old-style labels (e.g. '2026-W42')
// that don't carry their dates.
function getCycleDaysLeft(cycle) {
  let start;
  let totalDays;

  const monthly = /^(\d{4})-(\d{2})$/.exec(cycle);
  const weekly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cycle);

  if (monthly) {
    const year = Number(monthly[1]);
    const month = Number(monthly[2]);
    start = new Date(year, month - 1, 1);
    totalDays = new Date(year, month, 0).getDate();
  } else if (weekly) {
    start = new Date(Number(weekly[1]), Number(weekly[2]) - 1, Number(weekly[3]));
    totalDays = 7;
  } else {
    return null;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const elapsed = Math.round((today.getTime() - start.getTime()) / 86400000);
  const day = Math.min(Math.max(elapsed + 1, 1), totalDays);

  return { day, totalDays, daysLeft: totalDays - day };
}

module.exports = { getCurrentCycleLabel, describeCycle, getCycleDaysLeft };
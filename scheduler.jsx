import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ---------------------------------------------------------------
   Constants
--------------------------------------------------------------- */
const SHIFTS = [
  { id: "M", label: "Morning", time: "08:00–15:00", hours: 7 },
  { id: "A", label: "Afternoon", time: "15:00–22:00", hours: 7 },
  { id: "N", label: "Night", time: "22:00–08:00", hours: 10 },
];
const SHIFT_MAP = Object.fromEntries(SHIFTS.map((s) => [s.id, s]));

const ROLES = ["cs", "am", "ts", "dm"];
const ROLE_LABEL = {
  cs: "Customer Support Representative",
  am: "Account Manager",
  ts: "Team Supervisor",
  dm: "Direct Manager",
};
const ROLE_SHORT = { cs: "CS Rep", am: "Account Mgr", ts: "Team Supervisor", dm: "Direct Manager" };
const MIN_HEAD = { cs: 3, am: 2, ts: 1 };
const SCHEDULED_ROLES = ["cs", "am", "ts"]; // dm is not scheduled
const WEEKLY_CAP = 48;

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/* ---------------------------------------------------------------
   Date helpers
--------------------------------------------------------------- */
function pad(n) { return String(n).padStart(2, "0"); }
function toKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function monthKeyNow(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function datesInMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const out = [];
  const d = new Date(y, m - 1, 1);
  while (d.getMonth() === m - 1) {
    out.push(toKey(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}
function weekdayIdx(dateStr) {
  // Monday = 0 ... Sunday = 6
  const d = new Date(dateStr + "T00:00:00");
  return (d.getDay() + 6) % 7;
}
function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const wi = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wi);
  return toKey(d);
}
function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTH_LABELS[m - 1]} ${y}`;
}

/* ---------------------------------------------------------------
   Storage helpers
--------------------------------------------------------------- */
async function loadShared(key, fallback) {
  try {
    const r = await window.storage.get(key, true);
    return r ? JSON.parse(r.value) : fallback;
  } catch (e) {
    return fallback;
  }
}
async function saveShared(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), true);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------------
   Scheduler engine
--------------------------------------------------------------- */
function isDayOff(prefs, username, dateStr) {
  const p = prefs[username];
  return !!(p && p.daysOff && p.daysOff.includes(dateStr));
}

function generateSchedule(role, monthKey, workers, prefs, mode, approvedOT) {
  const dates = datesInMonth(monthKey);
  const minHead = MIN_HEAD[role];
  const state = {};
  workers.forEach((w) => (state[w.username] = { weeklyHours: {}, monthlyShifts: 0 }));
  const assignments = {};
  const conflicts = [];
  const overtimeNeeded = [];
  let template = null;

  dates.forEach((dateStr, di) => {
    const wk = mondayOfWeek(dateStr);
    const wi = weekdayIdx(dateStr);
    assignments[dateStr] = assignments[dateStr] || { M: [], A: [], N: [] };

    SHIFTS.forEach((shift) => {
      const need = minHead;
      let chosen = [];

      const alreadyToday = (uname) =>
        SHIFTS.some((s) => (assignments[dateStr][s.id] || []).includes(uname));

      // fixed-mode: try to reuse last week's pattern for this weekday first
      if (mode === "fixed" && template && template[wi] && template[wi][shift.id]) {
        template[wi][shift.id].forEach((uname) => {
          if (chosen.length >= need) return;
          const w = workers.find((x) => x.username === uname);
          if (!w) return;
          if (isDayOff(prefs, uname, dateStr)) return;
          if (alreadyToday(uname)) return;
          const st = state[uname];
          const curHours = st.weeklyHours[wk] || 0;
          const ot = approvedOT.has(uname + "|" + wk);
          if (curHours + shift.hours <= WEEKLY_CAP || ot) chosen.push(uname);
        });
      }

      if (chosen.length < need) {
        const pool = workers
          .filter((w) => !chosen.includes(w.username))
          .filter((w) => !isDayOff(prefs, w.username, dateStr))
          .filter((w) => !alreadyToday(w.username));
        pool.sort((a, b) => {
          const ah = state[a.username].weeklyHours[wk] || 0;
          const bh = state[b.username].weeklyHours[wk] || 0;
          if (ah !== bh) return ah - bh;
          return state[a.username].monthlyShifts - state[b.username].monthlyShifts;
        });
        for (const w of pool) {
          if (chosen.length >= need) break;
          const st = state[w.username];
          const curHours = st.weeklyHours[wk] || 0;
          const ot = approvedOT.has(w.username + "|" + wk);
          if (curHours + shift.hours <= WEEKLY_CAP || ot) chosen.push(w.username);
        }
        if (chosen.length < need) {
          for (const w of pool) {
            if (chosen.length >= need) break;
            if (chosen.includes(w.username)) continue;
            const st = state[w.username];
            const curHours = st.weeklyHours[wk] || 0;
            if (curHours + shift.hours > WEEKLY_CAP) {
              chosen.push(w.username);
              overtimeNeeded.push({ username: w.username, weekKey: wk, projectedHours: curHours + shift.hours, date: dateStr, shift: shift.id });
            }
          }
        }
      }

      assignments[dateStr][shift.id] = chosen;
      chosen.forEach((uname) => {
        const st = state[uname];
        st.weeklyHours[wk] = (st.weeklyHours[wk] || 0) + shift.hours;
        st.monthlyShifts += 1;
      });
      if (chosen.length < need) {
        conflicts.push({ type: "understaffed", date: dateStr, shift: shift.id, short: need - chosen.length });
      }
    });

    if (mode === "fixed" && di < 7) {
      template = template || {};
      template[wi] = assignments[dateStr];
    }
  });

  // days-off-per-week check
  workers.forEach((w) => {
    const weeks = {};
    dates.forEach((dateStr) => {
      const wk = mondayOfWeek(dateStr);
      weeks[wk] = weeks[wk] || { worked: 0, total: 0 };
      weeks[wk].total += 1;
      const workedToday = SHIFTS.some((s) => (assignments[dateStr][s.id] || []).includes(w.username));
      if (workedToday) weeks[wk].worked += 1;
    });
    Object.entries(weeks).forEach(([wk, info]) => {
      const daysOff = info.total - info.worked;
      if (info.total >= 6 && daysOff < 2) {
        conflicts.push({ type: "days-off", username: w.username, weekKey: wk, daysOff });
      }
    });
  });

  return { assignments, conflicts, overtimeNeeded };
}

function hoursForUserInMonth(assignments, username) {
  let total = 0;
  const byWeek = {};
  Object.entries(assignments || {}).forEach(([dateStr, dayObj]) => {
    const wk = mondayOfWeek(dateStr);
    SHIFTS.forEach((s) => {
      if ((dayObj[s.id] || []).includes(username)) {
        total += s.hours;
        byWeek[wk] = (byWeek[wk] || 0) + s.hours;
      }
    });
  });
  return { total, byWeek };
}

/* ---------------------------------------------------------------
   Small UI atoms
--------------------------------------------------------------- */
function RoleBadge({ role }) {
  return <span className={`role-badge role-${role}`}>{ROLE_SHORT[role]}</span>;
}
function ShiftPill({ id }) {
  const s = SHIFT_MAP[id];
  return (
    <span className={`shift-pill shift-${id}`}>
      <span className="shift-dot" />
      {s.label}
    </span>
  );
}
function StatusTag({ status }) {
  const map = { "not-generated": "Not generated", draft: "Draft — needs review", published: "Published" };
  return <span className={`status-tag status-${status}`}>{map[status] || status}</span>;
}

/* ---------------------------------------------------------------
   Login
--------------------------------------------------------------- */
function LoginScreen({ accounts, onLogin, seeding }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function submit(e) {
    e.preventDefault();
    const acc = accounts.find((a) => a.username === username.trim());
    if (!acc || acc.password !== password) {
      setError("Username or password is incorrect.");
      return;
    }
    if (!acc.active) {
      setError("This account has been deactivated.");
      return;
    }
    setError("");
    onLogin(acc);
  }

  return (
    <div className="login-screen">
      <style>{FONT_IMPORT}</style>
      <div className="login-hero">
        <ClockGlyph />
        <h1>Rotalink</h1>
        <p className="login-tag">Shift scheduling, built around your roster's hours — not the other way around.</p>
        <div className="hero-legend">
          <div><span className="dot shift-M" /> Morning 08:00–15:00</div>
          <div><span className="dot shift-A" /> Afternoon 15:00–22:00</div>
          <div><span className="dot shift-N" /> Night 22:00–08:00</div>
        </div>
      </div>
      <div className="login-panel">
        <form onSubmit={submit} className="login-form">
          <h2>Sign in</h2>
          {seeding && (
            <div className="seed-note">
              No accounts exist yet. A starter Direct Manager account has been created:
              <br /><b>username:</b> admin &nbsp; <b>password:</b> admin123
              <br />Sign in and add your team from Accounts.
            </div>
          )}
          <label>Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </label>
          <label>Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn btn-primary btn-block">Sign in</button>
          <p className="login-footnote">Accounts are created by your Direct Manager. This is a working prototype — passwords here are stored in plain form for demo purposes and shared across everyone using this app; don't reuse a real password.</p>
        </form>
      </div>
    </div>
  );
}

function ClockGlyph() {
  return (
    <svg viewBox="0 0 200 200" className="clock-glyph" aria-hidden="true">
      <circle cx="100" cy="100" r="92" fill="none" stroke="var(--line-strong)" strokeWidth="2" />
      <path d="M100 100 L100 12 A88 88 0 0 1 176 144 Z" fill="var(--morning)" opacity="0.9" />
      <path d="M100 100 L176 144 A88 88 0 0 1 24 144 Z" fill="var(--afternoon)" opacity="0.9" />
      <path d="M100 100 L24 144 A88 88 0 0 1 100 12 Z" fill="var(--night)" opacity="0.9" />
      <circle cx="100" cy="100" r="34" fill="var(--ink)" />
      <text x="100" y="106" textAnchor="middle" fontSize="13" fill="#fff" fontFamily="Archivo, sans-serif" fontWeight="700">24H</text>
    </svg>
  );
}

/* ---------------------------------------------------------------
   Month picker
--------------------------------------------------------------- */
function MonthPicker({ value, onChange, range = [-1, 0, 1, 2] }) {
  return (
    <select className="month-picker" value={value} onChange={(e) => onChange(e.target.value)}>
      {range.map((off) => {
        const k = monthKeyNow(off);
        return <option key={k} value={k}>{monthLabel(k)}</option>;
      })}
    </select>
  );
}

/* ---------------------------------------------------------------
   Accounts panel (DM only)
--------------------------------------------------------------- */
function AccountsPanel({ accounts, onSave }) {
  const [form, setForm] = useState({ name: "", username: "", password: "", role: "cs" });
  const [err, setErr] = useState("");

  function addAccount(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.username.trim() || !form.password.trim()) {
      setErr("Fill in name, username and a temporary password.");
      return;
    }
    if (accounts.some((a) => a.username === form.username.trim())) {
      setErr("That username is already taken.");
      return;
    }
    const next = [...accounts, { ...form, name: form.name.trim(), username: form.username.trim(), active: true }];
    onSave(next);
    setForm({ name: "", username: "", password: "", role: "cs" });
    setErr("");
  }

  function toggleActive(username) {
    onSave(accounts.map((a) => (a.username === username ? { ...a, active: !a.active } : a)));
  }

  return (
    <div className="panel">
      <h2>Team accounts</h2>
      <p className="panel-sub">Add every worker once. They'll sign in with the username and temporary password you set here.</p>
      <form className="account-form" onSubmit={addAccount}>
        <input placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input placeholder="Temporary password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="cs">Customer Support Representative</option>
          <option value="am">Account Manager</option>
          <option value="ts">Team Supervisor</option>
          <option value="dm">Direct Manager</option>
        </select>
        <button className="btn btn-primary" type="submit">Add account</button>
      </form>
      {err && <div className="form-error">{err}</div>}

      <table className="acct-table">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.username} className={!a.active ? "row-inactive" : ""}>
              <td>{a.name}</td>
              <td>{a.username}</td>
              <td><RoleBadge role={a.role} /></td>
              <td>{a.active ? "Active" : "Deactivated"}</td>
              <td><button className="btn btn-ghost btn-sm" onClick={() => toggleActive(a.username)}>{a.active ? "Deactivate" : "Reactivate"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------
   Preferences panel (self-service)
--------------------------------------------------------------- */
function PreferencesPanel({ user, prefsForMonth, monthKey, onMonthChange, onSubmit }) {
  const mine = prefsForMonth[user.username] || { daysOff: [], notes: "" };
  const [daysOff, setDaysOff] = useState(mine.daysOff);
  const [notes, setNotes] = useState(mine.notes);

  useEffect(() => {
    const m = prefsForMonth[user.username] || { daysOff: [], notes: "" };
    setDaysOff(m.daysOff);
    setNotes(m.notes);
  }, [monthKey, prefsForMonth, user.username]);

  const dates = datesInMonth(monthKey);
  const leadBlanks = weekdayIdx(dates[0]);

  function toggleDay(d) {
    setDaysOff((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  return (
    <div className="panel">
      <div className="panel-head-row">
        <h2>Monthly preferences</h2>
        <MonthPicker value={monthKey} onChange={onMonthChange} />
      </div>
      <p className="panel-sub">Mark the days you'd like off, then add a note on the shift types you'd prefer. The Direct Manager reviews every draft schedule before it's published.</p>

      <div className="cal-grid">
        {WEEKDAY_LABELS.map((w) => <div key={w} className="cal-dow">{w}</div>)}
        {Array.from({ length: leadBlanks }).map((_, i) => <div key={"b" + i} className="cal-cell cal-blank" />)}
        {dates.map((d) => {
          const day = Number(d.split("-")[2]);
          const off = daysOff.includes(d);
          return (
            <button type="button" key={d} className={`cal-cell cal-day ${off ? "cal-day-off" : ""}`} onClick={() => toggleDay(d)}>
              {day}
              {off && <span className="cal-off-label">Off</span>}
            </button>
          );
        })}
      </div>

      <label className="notes-label">Preferred shift types / other notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="e.g. Prefer mornings, can't do nights on weekends…" />
      </label>

      <button className="btn btn-primary" onClick={() => onSubmit({ daysOff, notes })}>Save preferences</button>
    </div>
  );
}

/* ---------------------------------------------------------------
   Schedule board (shared by manage + read-only views)
--------------------------------------------------------------- */
function ScheduleBoard({ role, monthKey, workers, schedule, editable, onEditCell, highlightUser }) {
  const dates = datesInMonth(monthKey);
  const assignments = schedule?.assignments || {};
  const nameOf = (u) => workers.find((w) => w.username === u)?.name || u;

  return (
    <div className="board-scroll">
      <table className="board-table">
        <thead>
          <tr>
            <th className="board-datecol">Date</th>
            {SHIFTS.map((s) => <th key={s.id}><ShiftPill id={s.id} /><div className="board-time">{s.time}</div></th>)}
          </tr>
        </thead>
        <tbody>
          {dates.map((d) => {
            const day = assignments[d] || { M: [], A: [], N: [] };
            const wi = weekdayIdx(d);
            return (
              <tr key={d} className={wi >= 5 ? "row-weekend" : ""}>
                <td className="board-datecol">{WEEKDAY_LABELS[wi]} {Number(d.split("-")[2])}</td>
                {SHIFTS.map((s) => (
                  <td key={s.id} className={`board-cell shift-cell-${s.id}`}>
                    {(day[s.id] || []).map((u) => (
                      <span key={u} className={`chip ${highlightUser === u ? "chip-highlight" : ""}`}>
                        {nameOf(u)}
                        {editable && (
                          <button className="chip-x" onClick={() => onEditCell(d, s.id, "remove", u)} aria-label="Remove">×</button>
                        )}
                      </span>
                    ))}
                    {(day[s.id] || []).length < MIN_HEAD[role] && (
                      <span className="short-flag">short {MIN_HEAD[role] - (day[s.id] || []).length}</span>
                    )}
                    {editable && (
                      <select className="cell-add" value="" onChange={(e) => { if (e.target.value) onEditCell(d, s.id, "add", e.target.value); }}>
                        <option value="">+ add</option>
                        {workers.filter((w) => !(day[s.id] || []).includes(w.username)).map((w) => (
                          <option key={w.username} value={w.username}>{w.name}</option>
                        ))}
                      </select>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------
   Manage schedule (DM): generate, resolve conflicts, publish
--------------------------------------------------------------- */
function ManageSchedule({ role, monthKey, onMonthChange, workers, schedule, onGenerate, onEditCell, onPublish, onUnpublish, overtime, onOvertimeDecision }) {
  const [mode, setMode] = useState("vary");
  const conflicts = schedule?.conflicts || [];
  const status = schedule?.status || "not-generated";
  const pendingOT = (overtime || []).filter((o) => o.status === "pending");

  return (
    <div className="panel">
      <div className="panel-head-row">
        <h2>{ROLE_SHORT[role]} schedule</h2>
        <div className="row-gap">
          <MonthPicker value={monthKey} onChange={onMonthChange} />
          <StatusTag status={status} />
        </div>
      </div>

      {status !== "published" && (
        <div className="gen-bar">
          <label className="mode-choice">
            <input type="radio" checked={mode === "vary"} onChange={() => setMode("vary")} /> Vary week to week
          </label>
          <label className="mode-choice">
            <input type="radio" checked={mode === "fixed"} onChange={() => setMode("fixed")} /> Repeat week 1's pattern
          </label>
          <button className="btn btn-primary" onClick={() => onGenerate(mode)}>
            {status === "draft" ? "Regenerate draft" : "Generate draft"}
          </button>
        </div>
      )}

      {workers.length === 0 && <p className="empty-note">No {ROLE_LABEL[role].toLowerCase()}s added yet — add accounts first.</p>}

      {schedule && (
        <>
          {(conflicts.length > 0 || pendingOT.length > 0) && (
            <div className="conflict-box">
              <h3>Needs your attention</h3>
              {pendingOT.map((o) => (
                <div key={o.id} className="conflict-row">
                  <span><b>{workers.find((w) => w.username === o.username)?.name || o.username}</b> would exceed 48h in the week of {o.weekKey} ({o.projectedHours}h). Approve overtime?</span>
                  <span className="row-gap">
                    <button className="btn btn-sm btn-primary" onClick={() => onOvertimeDecision(o.id, "approved")}>Approve</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => onOvertimeDecision(o.id, "denied")}>Deny</button>
                  </span>
                </div>
              ))}
              {conflicts.filter((c) => c.type === "understaffed").map((c, i) => (
                <div key={"u" + i} className="conflict-row">
                  {monthLabel(monthKey).split(" ")[0]} {c.date.split("-")[2]} · {SHIFT_MAP[c.shift].label} is short {c.short} {c.short === 1 ? "person" : "people"} — add someone in the table below.
                </div>
              ))}
              {conflicts.filter((c) => c.type === "days-off").map((c, i) => (
                <div key={"d" + i} className="conflict-row">
                  {workers.find((w) => w.username === c.username)?.name || c.username} only has {c.daysOff} day{c.daysOff === 1 ? "" : "s"} off in the week of {c.weekKey} (needs 2) — remove a shift to fix.
                </div>
              ))}
            </div>
          )}

          <ScheduleBoard role={role} monthKey={monthKey} workers={workers} schedule={schedule} editable={status !== "published"} onEditCell={onEditCell} />

          <div className="publish-bar">
            {status === "published" ? (
              <button className="btn btn-ghost" onClick={onUnpublish}>Unpublish for edits</button>
            ) : (
              <button className="btn btn-primary" disabled={!schedule} onClick={onPublish}>Publish schedule</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   My schedule (self, read only)
--------------------------------------------------------------- */
function MySchedule({ user, monthKey, onMonthChange, workers, schedule }) {
  const status = schedule?.status;
  const { total, byWeek } = useMemo(() => hoursForUserInMonth(schedule?.assignments, user.username), [schedule, user.username]);

  return (
    <div className="panel">
      <div className="panel-head-row">
        <h2>My schedule</h2>
        <div className="row-gap"><MonthPicker value={monthKey} onChange={onMonthChange} /> {status && <StatusTag status={status} />}</div>
      </div>
      {status !== "published" ? (
        <p className="empty-note">Your schedule for {monthLabel(monthKey)} hasn't been published yet.</p>
      ) : (
        <>
          <div className="hours-summary">
            <div><span className="hours-num">{total}</span> hours this month</div>
            {Object.entries(byWeek).map(([wk, h]) => (
              <div key={wk} className={`week-chip ${h > WEEKLY_CAP ? "week-over" : ""}`}>Week of {wk}: {h}h</div>
            ))}
          </div>
          <ScheduleBoard role={user.role} monthKey={monthKey} workers={workers} schedule={schedule} editable={false} highlightUser={user.username} />
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Read-only team view (AM sees CS, TS sees CS+AM)
--------------------------------------------------------------- */
function TeamView({ role, monthKey, onMonthChange, workers, schedule }) {
  return (
    <div className="panel">
      <div className="panel-head-row">
        <h2>{ROLE_LABEL[role]} schedule</h2>
        <div className="row-gap"><MonthPicker value={monthKey} onChange={onMonthChange} /> {schedule && <StatusTag status={schedule.status} />}</div>
      </div>
      {(!schedule || schedule.status !== "published") ? (
        <p className="empty-note">Not published yet for {monthLabel(monthKey)}.</p>
      ) : (
        <ScheduleBoard role={role} monthKey={monthKey} workers={workers} schedule={schedule} editable={false} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Dashboard shell
--------------------------------------------------------------- */
function Dashboard({ user, accounts, onLogout, onAccountsSave }) {
  const [tab, setTab] = useState(user.role === "dm" ? "accounts" : "mine");
  const [genMonth, setGenMonth] = useState(monthKeyNow(1));
  const [prefMonth, setPrefMonth] = useState(monthKeyNow(1));
  const [mineMonth, setMineMonth] = useState(monthKeyNow(0));
  const [genRole, setGenRole] = useState("cs");

  const [prefs, setPrefs] = useState({});
  const [schedules, setSchedules] = useState({});
  const [overtime, setOvertime] = useState({});
  const [loaded, setLoaded] = useState(false);

  const workersByRole = useCallback((role) => accounts.filter((a) => a.role === role && a.active), [accounts]);

  useEffect(() => {
    (async () => {
      const p = await loadShared(`preferences:${prefMonth}`, {});
      setPrefs((prev) => ({ ...prev, [prefMonth]: p }));
    })();
  }, [prefMonth]);

  useEffect(() => {
    (async () => {
      const p = await loadShared(`preferences:${genMonth}`, {});
      setPrefs((prev) => ({ ...prev, [genMonth]: p }));
      const s = await loadShared(`schedules:${genMonth}`, {});
      setSchedules((prev) => ({ ...prev, [genMonth]: s }));
      const ot = await loadShared(`overtime:${genMonth}`, []);
      setOvertime((prev) => ({ ...prev, [genMonth]: ot }));
      setLoaded(true);
    })();
  }, [genMonth]);

  useEffect(() => {
    (async () => {
      const s = await loadShared(`schedules:${mineMonth}`, {});
      setSchedules((prev) => ({ ...prev, [mineMonth]: s }));
    })();
  }, [mineMonth]);

  async function savePrefs(monthKey, values) {
    const current = await loadShared(`preferences:${monthKey}`, {});
    const next = { ...current, [user.username]: values };
    await saveShared(`preferences:${monthKey}`, next);
    setPrefs((prev) => ({ ...prev, [monthKey]: next }));
  }

  async function generate(role, monthKey, mode) {
    const workers = workersByRole(role);
    const monthPrefs = prefs[monthKey] || (await loadShared(`preferences:${monthKey}`, {}));
    const otList = await loadShared(`overtime:${monthKey}`, []);
    const approvedSet = new Set(otList.filter((o) => o.status === "approved").map((o) => o.username + "|" + o.weekKey));
    const result = generateSchedule(role, monthKey, workers, monthPrefs, mode, approvedSet);

    const currentSchedules = await loadShared(`schedules:${monthKey}`, {});
    const nextSchedules = { ...currentSchedules, [role]: { assignments: result.assignments, conflicts: result.conflicts, status: "draft" } };
    await saveShared(`schedules:${monthKey}`, nextSchedules);
    setSchedules((prev) => ({ ...prev, [monthKey]: nextSchedules }));

    const existingKeys = new Set(otList.map((o) => o.username + "|" + o.weekKey + "|" + o.date + "|" + o.shift));
    const newReqs = result.overtimeNeeded
      .filter((o) => !existingKeys.has(o.username + "|" + o.weekKey + "|" + o.date + "|" + o.shift))
      .map((o, i) => ({ id: `${role}-${monthKey}-${Date.now()}-${i}`, role, username: o.username, weekKey: o.weekKey, projectedHours: o.projectedHours, date: o.date, shift: o.shift, status: "pending" }));
    const nextOT = [...otList.filter((o) => o.role === role ? true : true), ...newReqs];
    await saveShared(`overtime:${monthKey}`, nextOT);
    setOvertime((prev) => ({ ...prev, [monthKey]: nextOT }));
  }

  async function editCell(role, monthKey, date, shiftId, action, username) {
    const currentSchedules = await loadShared(`schedules:${monthKey}`, {});
    const sched = currentSchedules[role];
    if (!sched) return;
    const assignments = { ...sched.assignments };
    const day = { ...(assignments[date] || { M: [], A: [], N: [] }) };
    let list = [...(day[shiftId] || [])];
    if (action === "add" && !list.includes(username)) list.push(username);
    if (action === "remove") list = list.filter((u) => u !== username);
    day[shiftId] = list;
    assignments[date] = day;

    // recompute understaffed conflicts freshly (keep days-off/overtime conflicts as generated)
    const otherConflicts = (sched.conflicts || []).filter((c) => !(c.type === "understaffed" && c.date === date && c.shift === shiftId));
    const shortBy = MIN_HEAD[role] - list.length;
    const nextConflicts = shortBy > 0 ? [...otherConflicts, { type: "understaffed", date, shift: shiftId, short: shortBy }] : otherConflicts;

    const nextSched = { ...sched, assignments, conflicts: nextConflicts };
    const nextSchedules = { ...currentSchedules, [role]: nextSched };
    await saveShared(`schedules:${monthKey}`, nextSchedules);
    setSchedules((prev) => ({ ...prev, [monthKey]: nextSchedules }));
  }

  async function setStatus(role, monthKey, status) {
    const currentSchedules = await loadShared(`schedules:${monthKey}`, {});
    if (!currentSchedules[role]) return;
    const nextSchedules = { ...currentSchedules, [role]: { ...currentSchedules[role], status } };
    await saveShared(`schedules:${monthKey}`, nextSchedules);
    setSchedules((prev) => ({ ...prev, [monthKey]: nextSchedules }));
  }

  async function decideOvertime(monthKey, id, decision) {
    const otList = await loadShared(`overtime:${monthKey}`, []);
    const req = otList.find((o) => o.id === id);
    const nextOT = otList.map((o) => (o.id === id ? { ...o, status: decision } : o));
    await saveShared(`overtime:${monthKey}`, nextOT);
    setOvertime((prev) => ({ ...prev, [monthKey]: nextOT }));
    if (req && decision === "denied") {
      await editCell(req.role, monthKey, req.date, req.shift, "remove", req.username);
    }
  }

  const navItems = useMemo(() => {
    if (user.role === "dm") return [
      { id: "accounts", label: "Accounts" },
      { id: "manage", label: "Schedules" },
    ];
    if (user.role === "ts") return [
      { id: "mine", label: "My schedule" },
      { id: "prefs", label: "Submit preferences" },
      { id: "team-am", label: "Account Managers" },
      { id: "team-cs", label: "Customer Support" },
    ];
    if (user.role === "am") return [
      { id: "mine", label: "My schedule" },
      { id: "prefs", label: "Submit preferences" },
      { id: "team-cs", label: "Customer Support" },
    ];
    return [
      { id: "mine", label: "My schedule" },
      { id: "prefs", label: "Submit preferences" },
    ];
  }, [user.role]);

  return (
    <div className="app-shell">
      <style>{FONT_IMPORT}</style>
      <aside className="sidebar">
        <div className="brand"><ClockGlyph small /><span>Rotalink</span></div>
        <nav>
          {navItems.map((n) => (
            <button key={n.id} className={`nav-item ${tab === n.id ? "nav-active" : ""}`} onClick={() => setTab(n.id)}>{n.label}</button>
          ))}
        </nav>
        <div className="sidebar-user">
          <RoleBadge role={user.role} />
          <div className="sidebar-name">{user.name}</div>
          <button className="btn btn-ghost btn-sm btn-block" onClick={onLogout}>Sign out</button>
        </div>
      </aside>

      <main className="main-area">
        {tab === "accounts" && <AccountsPanel accounts={accounts} onSave={onAccountsSave} />}

        {tab === "manage" && (
          <div className="manage-wrap">
            <div className="role-tabs">
              {SCHEDULED_ROLES.map((r) => (
                <button key={r} className={`role-tab ${genRole === r ? "role-tab-active" : ""}`} onClick={() => setGenRole(r)}>{ROLE_SHORT[r]}</button>
              ))}
            </div>
            <ManageSchedule
              role={genRole}
              monthKey={genMonth}
              onMonthChange={setGenMonth}
              workers={workersByRole(genRole)}
              schedule={schedules[genMonth]?.[genRole]}
              overtime={(overtime[genMonth] || []).filter((o) => o.role === genRole)}
              onGenerate={(mode) => generate(genRole, genMonth, mode)}
              onEditCell={(date, shiftId, action, username) => editCell(genRole, genMonth, date, shiftId, action, username)}
              onPublish={() => setStatus(genRole, genMonth, "published")}
              onUnpublish={() => setStatus(genRole, genMonth, "draft")}
              onOvertimeDecision={(id, decision) => decideOvertime(genMonth, id, decision)}
            />
          </div>
        )}

        {tab === "prefs" && (
          <PreferencesPanel
            user={user}
            monthKey={prefMonth}
            onMonthChange={setPrefMonth}
            prefsForMonth={prefs[prefMonth] || {}}
            onSubmit={(values) => savePrefs(prefMonth, values)}
          />
        )}

        {tab === "mine" && (
          <MySchedule user={user} monthKey={mineMonth} onMonthChange={setMineMonth} workers={workersByRole(user.role)} schedule={schedules[mineMonth]?.[user.role]} />
        )}

        {tab === "team-cs" && (
          <TeamViewLoader role="cs" workers={workersByRole("cs")} />
        )}
        {tab === "team-am" && (
          <TeamViewLoader role="am" workers={workersByRole("am")} />
        )}
      </main>
    </div>
  );
}

function TeamViewLoader({ role, workers }) {
  const [monthKey, setMonthKey] = useState(monthKeyNow(0));
  const [schedule, setSchedule] = useState(null);
  useEffect(() => {
    (async () => {
      const s = await loadShared(`schedules:${monthKey}`, {});
      setSchedule(s[role] || null);
    })();
  }, [monthKey, role]);
  return <TeamView role={role} monthKey={monthKey} onMonthChange={setMonthKey} workers={workers} schedule={schedule} />;
}

/* ---------------------------------------------------------------
   App root
--------------------------------------------------------------- */
export default function App() {
  const [accounts, setAccounts] = useState(null);
  const [user, setUser] = useState(null);
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    (async () => {
      let a = await loadShared("accounts", null);
      if (!a || a.length === 0) {
        a = [{ name: "Direct Manager", username: "admin", password: "admin123", role: "dm", active: true }];
        await saveShared("accounts", a);
        setSeeding(true);
      }
      setAccounts(a);
    })();
  }, []);

  async function saveAccounts(next) {
    setAccounts(next);
    await saveShared("accounts", next);
  }

  if (!accounts) {
    return <div className="loading-screen"><style>{FONT_IMPORT}</style>Loading…</div>;
  }

  if (!user) {
    return <LoginScreen accounts={accounts} onLogin={setUser} seeding={seeding} />;
  }

  return <Dashboard user={user} accounts={accounts} onLogout={() => setUser(null)} onAccountsSave={saveAccounts} />;
}

/* ---------------------------------------------------------------
   Styles
--------------------------------------------------------------- */
const FONT_IMPORT = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

:root{
  --ink:#12172B; --surface:#F7F8FB; --surface2:#FFFFFF; --line:#E1E5EE; --line-strong:#C7CCDA;
  --morning:#E3A23C; --afternoon:#D8553A; --night:#4F5FD1;
  --text:#1B1F2E; --muted:#5B6178; --good:#2F9E6E; --danger:#D6432F;
}
*{box-sizing:border-box;}
body,.app-shell,.login-screen,.loading-screen{font-family:'IBM Plex Sans',sans-serif;color:var(--text);}
h1,h2,h3{font-family:'Archivo',sans-serif;}
.loading-screen{display:flex;align-items:center;justify-content:center;height:100vh;background:var(--surface);}

.login-screen{display:grid;grid-template-columns:1.1fr 1fr;min-height:100vh;background:var(--surface);}
.login-hero{background:var(--ink);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px;text-align:center;}
.clock-glyph{width:140px;height:140px;margin-bottom:20px;}
.login-hero h1{font-size:34px;font-weight:800;margin:0 0 8px;letter-spacing:-0.01em;}
.login-tag{color:#C6CBE0;max-width:340px;line-height:1.5;margin:0 0 24px;}
.hero-legend{display:flex;flex-direction:column;gap:8px;font-size:14px;color:#DCE0F0;}
.hero-legend .dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:8px;}
.dot.shift-M{background:var(--morning);} .dot.shift-A{background:var(--afternoon);} .dot.shift-N{background:var(--night);}

.login-panel{display:flex;align-items:center;justify-content:center;padding:24px;}
.login-form{width:100%;max-width:340px;display:flex;flex-direction:column;gap:14px;}
.login-form h2{margin:0 0 4px;font-size:22px;}
.login-form label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted);font-weight:500;}
.login-form input{padding:10px 12px;border:1px solid var(--line-strong);border-radius:8px;font-size:14px;font-family:inherit;}
.seed-note{background:#FBF3E4;border:1px solid #E9D6AC;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.5;}
.login-footnote{font-size:12px;color:var(--muted);line-height:1.5;margin-top:4px;}
.form-error{background:#FBE7E3;color:#9C2E1E;padding:8px 10px;border-radius:6px;font-size:13px;}

.btn{border:none;border-radius:8px;padding:10px 16px;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;}
.btn-primary{background:var(--ink);color:#fff;}
.btn-primary:hover{background:#232a45;}
.btn-primary:disabled{opacity:0.4;cursor:not-allowed;}
.btn-ghost{background:transparent;border:1px solid var(--line-strong);color:var(--text);}
.btn-ghost:hover{background:var(--surface);}
.btn-sm{padding:6px 10px;font-size:13px;}
.btn-block{width:100%;}

.app-shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh;background:var(--surface);}
.sidebar{background:var(--ink);color:#fff;padding:20px 16px;display:flex;flex-direction:column;gap:20px;}
.brand{display:flex;align-items:center;gap:8px;font-family:'Archivo',sans-serif;font-weight:800;font-size:18px;}
.brand svg{width:28px;height:28px;}
.sidebar nav{display:flex;flex-direction:column;gap:4px;flex:1;}
.nav-item{background:transparent;border:none;color:#C6CBE0;text-align:left;padding:10px 12px;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;font-weight:500;}
.nav-item:hover{background:#1E2440;color:#fff;}
.nav-active{background:#2A3155;color:#fff;}
.sidebar-user{border-top:1px solid #2A3155;padding-top:14px;display:flex;flex-direction:column;gap:8px;}
.sidebar-name{font-size:14px;font-weight:600;}

.main-area{padding:32px 40px;overflow-x:auto;}
.panel{max-width:1000px;}
.panel h2{font-size:22px;margin:0 0 4px;}
.panel-sub{color:var(--muted);font-size:14px;margin:0 0 20px;max-width:640px;line-height:1.5;}
.panel-head-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:6px;}
.row-gap{display:flex;align-items:center;gap:10px;}

.role-badge{font-size:11px;font-weight:700;padding:4px 9px;border-radius:20px;display:inline-block;}
.role-cs{background:#E4ECFB;color:#2A5CAE;}
.role-am{background:#EAE3FA;color:#6A3EBE;}
.role-ts{background:#FDE9DD;color:#B4531B;}
.role-dm{background:#111528;color:#fff;}

.status-tag{font-size:12px;font-weight:600;padding:5px 10px;border-radius:20px;}
.status-not-generated{background:#EDEEF3;color:var(--muted);}
.status-draft{background:#FBF0DC;color:#9A6B12;}
.status-published{background:#E1F3EA;color:#1E7A50;}

.month-picker{padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;font-family:inherit;font-size:13px;background:#fff;}

.account-form{display:grid;grid-template-columns:1.3fr 1fr 1fr 1.4fr auto;gap:8px;margin-bottom:14px;align-items:center;}
.account-form input,.account-form select{padding:9px 10px;border:1px solid var(--line-strong);border-radius:8px;font-family:inherit;font-size:13px;}
.acct-table{width:100%;border-collapse:collapse;font-size:14px;}
.acct-table th{text-align:left;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line);padding:8px 6px;}
.acct-table td{padding:9px 6px;border-bottom:1px solid var(--line);}
.row-inactive{opacity:0.5;}

.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:18px;max-width:520px;}
.cal-dow{font-size:11px;color:var(--muted);text-align:center;font-weight:600;padding-bottom:2px;}
.cal-cell{aspect-ratio:1;border-radius:8px;}
.cal-blank{background:transparent;}
.cal-day{border:1px solid var(--line-strong);background:#fff;cursor:pointer;font-size:13px;font-family:inherit;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;}
.cal-day:hover{border-color:var(--ink);}
.cal-day-off{background:var(--ink);color:#fff;border-color:var(--ink);}
.cal-off-label{font-size:9px;opacity:0.8;}
.notes-label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted);font-weight:500;max-width:520px;margin-bottom:16px;}
.notes-label textarea{padding:10px;border:1px solid var(--line-strong);border-radius:8px;font-family:inherit;font-size:14px;resize:vertical;}

.role-tabs{display:flex;gap:6px;margin-bottom:18px;}
.role-tab{background:#fff;border:1px solid var(--line-strong);padding:8px 14px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
.role-tab-active{background:var(--ink);color:#fff;border-color:var(--ink);}

.gen-bar{display:flex;align-items:center;gap:16px;background:#fff;border:1px solid var(--line);padding:14px 16px;border-radius:10px;margin-bottom:18px;flex-wrap:wrap;}
.mode-choice{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;}

.conflict-box{background:#FFF8ED;border:1px solid #F0DBA8;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.conflict-box h3{margin:0 0 10px;font-size:14px;}
.conflict-row{font-size:13px;padding:6px 0;border-top:1px solid #F0E2BC;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}
.conflict-row:first-of-type{border-top:none;}

.board-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:#fff;}
.board-table{width:100%;border-collapse:collapse;font-size:13px;min-width:640px;}
.board-table th{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);background:#FAFBFD;}
.board-time{font-size:11px;color:var(--muted);font-weight:400;margin-top:2px;}
.board-datecol{white-space:nowrap;font-weight:600;padding:8px 12px;}
.board-cell{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;min-width:150px;}
.row-weekend{background:#FBFBFD;}
.shift-cell-M{border-left:3px solid var(--morning);}
.shift-cell-A{border-left:3px solid var(--afternoon);}
.shift-cell-N{border-left:3px solid var(--night);}

.chip{display:inline-flex;align-items:center;gap:4px;background:#EEF0F6;border-radius:14px;padding:3px 8px 3px 10px;font-size:12px;margin:2px 3px 2px 0;}
.chip-highlight{background:var(--ink);color:#fff;}
.chip-x{background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0;}
.chip-highlight .chip-x{color:#C6CBE0;}
.short-flag{display:block;color:var(--danger);font-size:11px;font-weight:600;margin-top:2px;}
.cell-add{display:block;margin-top:4px;font-size:12px;border:1px dashed var(--line-strong);border-radius:6px;padding:3px 4px;background:transparent;font-family:inherit;color:var(--muted);}

.shift-pill{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px;}
.shift-dot{width:8px;height:8px;border-radius:50%;}
.shift-M .shift-dot{background:var(--morning);} .shift-A .shift-dot{background:var(--afternoon);} .shift-N .shift-dot{background:var(--night);}

.publish-bar{margin-top:16px;display:flex;justify-content:flex-end;}
.empty-note{color:var(--muted);font-size:14px;}

.hours-summary{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px;}
.hours-num{font-family:'Archivo',sans-serif;font-weight:800;font-size:22px;margin-right:6px;}
.week-chip{background:#EEF0F6;border-radius:20px;padding:5px 12px;font-size:12px;font-weight:600;}
.week-over{background:#FBE7E3;color:#9C2E1E;}

@media (max-width: 780px){
  .login-screen{grid-template-columns:1fr;}
  .login-hero{padding:32px 20px;}
  .app-shell{grid-template-columns:1fr;}
  .sidebar{flex-direction:row;flex-wrap:wrap;padding:14px 16px;}
  .sidebar nav{flex-direction:row;flex-wrap:wrap;}
  .main-area{padding:20px;}
  .account-form{grid-template-columns:1fr 1fr;}
}
`;

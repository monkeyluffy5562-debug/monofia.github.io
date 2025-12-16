const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const fs = require("fs-extra");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "db.json");
const STATIC_PATH = __dirname;
const TOKEN_TTL_HOURS = 12;

const sessions = new Map(); // token -> { username, role, expiresAt }

const COURSES = [
  "انتاج رسوم رقميه",
  "العمليات الفنيه في المكتبات",
  "تحليل و تصميم نظم المعلومات",
  "قواعد البيانات و امن المعلومات",
  "البرامج الصوتيه الرقميه",
  "اللغه الانجليزيه في التخصص",
  "تقنيات الطباعه الرقميه",
  "التدريس المصغر",
  "تاريخ التربيه و نظام التعليم في مصر",
  "علم نفس النمو"
].map((name, idx) => ({
  id: `C${idx + 1}`,
  name,
  sections: Array.from({ length: 5 }, (_v, i) => ({ id: `S${i + 1}`, name: `سيكشن ${i + 1}` }))
}));

const defaultDb = () => ({
  accounts: [
    {
      username: "almnofiadeveloper123",
      passwordHash: bcrypt.hashSync("almnofiadeveloper123123", 10),
      role: "developer",
      allowedSections: [] // فارغة تعني مسموح الكل
    }
  ],
  sessions: {}, // key: courseId-sectionId -> session object
  attendance: {}, // key: courseId-sectionId -> [records]
  histories: {} // username -> [records]
});

const hydrateDb = (db) => {
  const base = defaultDb();
  db.accounts = db.accounts || base.accounts;
  db.sessions = db.sessions || {};
  db.attendance = db.attendance || {};
  db.histories = db.histories || {};
  return db;
};

const loadDb = async () => {
  if (!(await fs.pathExists(DB_PATH))) {
    await fs.writeJson(DB_PATH, defaultDb(), { spaces: 2 });
  }
  try {
    const db = await fs.readJson(DB_PATH);
    return hydrateDb(db);
  } catch (err) {
    // إصلاح ملفات تالفة أو فارغة
    const fresh = defaultDb();
    await fs.writeJson(DB_PATH, fresh, { spaces: 2 });
    return fresh;
  }
};

const saveDb = async (db) => fs.writeJson(DB_PATH, db, { spaces: 2 });

const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  const session = sessions.get(token);
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: "Session expired" });
  }
  req.user = session;
  next();
};

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(STATIC_PATH));

app.get("/api/courses", (_req, res) => {
  res.json({ courses: COURSES });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const user = db.accounts.find((a) => a.username === username);
  if (!user) return res.status(401).json({ error: "بيانات غير صحيحة" });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "بيانات غير صحيحة" });
  const token = uuid();
  sessions.set(token, { username: user.username, role: user.role, expiresAt: Date.now() + TOKEN_TTL_HOURS * 3600 * 1000 });
  return res.json({ token, username: user.username, role: user.role, allowedSections: user.allowedSections || [] });
});

app.post("/api/accounts", authMiddleware, async (req, res) => {
  if (req.user.role !== "developer") return res.status(403).json({ error: "Forbidden" });
  const { username, password, role = "student", allowedSections = [] } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  if (db.accounts.some((a) => a.username === username)) return res.status(409).json({ error: "الحساب موجود بالفعل" });
  const normalizedAllowed = Array.isArray(allowedSections)
    ? allowedSections
    : String(allowedSections || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  db.accounts.push({ username, passwordHash: bcrypt.hashSync(password, 10), role, allowedSections: normalizedAllowed });
  await saveDb(db);
  return res.json({ ok: true });
});

const sessionKey = (courseId, sectionId) => `${courseId}-${sectionId}`;

const findCourse = (courseId) => COURSES.find((c) => c.id === courseId);
const findSection = (courseId, sectionId) => findCourse(courseId)?.sections.find((s) => s.id === sectionId);
const presentCount = (attendance = []) => (attendance || []).filter((r) => r.present).length;

app.post("/api/session/start", authMiddleware, async (req, res) => {
  const { courseId, sectionId, lecturer, durationMinutes = 90 } = req.body || {};
  if (!courseId || !sectionId || !lecturer) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!findSection(courseId, sectionId)) return res.status(404).json({ error: "مادة/سيكشن غير موجود" });
  const db = await loadDb();
  const sKey = sessionKey(courseId, sectionId);
  const sessionId = `SES-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const payload = JSON.stringify({ sessionId, courseId, sectionId, lecturer, ts: Date.now() });
  const startAt = Date.now();
  const endAt = startAt + Number(durationMinutes || 90) * 60 * 1000;
  const session = { sessionId, courseId, sectionId, lecturer, payload, createdAt: startAt, startAt, endAt, durationMinutes, active: true };
  db.sessions[sKey] = session;
  db.attendance[sKey] = [];
  // سجل للمحاضر
  db.histories[lecturer] = db.histories[lecturer] || [];
  db.histories[lecturer].push({ role: "lecturer", sessionId, courseId, sectionId, startAt, endAt, createdAt: startAt });
  await saveDb(db);
  return res.json(session);
});

app.post("/api/session/end", authMiddleware, async (req, res) => {
  const { courseId, sectionId } = req.body || {};
  if (!courseId || !sectionId) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const sKey = sessionKey(courseId, sectionId);
  const session = db.sessions[sKey];
  if (!session || !session.active) return res.status(400).json({ error: "لا توجد محاضرة نشطة" });
  session.active = false;
  session.endAt = session.endAt || Date.now();
  await saveDb(db);
  return res.json({ ok: true });
});

app.post("/api/session/refresh", authMiddleware, async (req, res) => {
  const { courseId, sectionId } = req.body || {};
  if (!courseId || !sectionId) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const sKey = sessionKey(courseId, sectionId);
  const session = db.sessions[sKey];
  if (!session) return res.status(400).json({ error: "لا توجد جلسة" });
  session.payload = JSON.stringify({ ...session, ts: Date.now() });
  await saveDb(db);
  return res.json(session);
});

app.get("/api/session/status", async (req, res) => {
  const { courseId, sectionId } = req.query;
  if (!courseId || !sectionId) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const sKey = sessionKey(courseId, sectionId);
  const session = (db.sessions && db.sessions[sKey]) || null;
  if (session && session.active && session.endAt && Date.now() > session.endAt) {
    session.active = false;
    await saveDb(db);
  }
  return res.json({ session });
});

app.get("/api/attendance", async (req, res) => {
  const { courseId, sectionId } = req.query;
  if (!courseId || !sectionId) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const sKey = sessionKey(courseId, sectionId);
  const list = (db.attendance && db.attendance[sKey]) || [];
  return res.json({ attendance: list });
});

app.post("/api/attendance", async (req, res) => {
  const { sessionId, courseId, sectionId, username, source = "scan", device, override = false } = req.body || {};
  if (!sessionId || !courseId || !sectionId || !username) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const sKey = sessionKey(courseId, sectionId);
  const session = db.sessions && db.sessions[sKey];
  if (!session || !session.active || session.sessionId !== sessionId) return res.status(400).json({ error: "جلسة غير مطابقة" });
  if (session.endAt && Date.now() > session.endAt) return res.status(400).json({ error: "المحاضرة انتهت" });
  // تحقق من السماح بالدخول
  const user = db.accounts.find((u) => u.username === username);
  if (!override && user && Array.isArray(user.allowedSections) && user.allowedSections.length > 0) {
    const key = `${courseId}-${sectionId}`;
    if (!user.allowedSections.includes(key)) {
      return res.status(403).json({ error: "غير مسموح بهذا السيكشن" });
    }
  }
  db.attendance[sKey] = db.attendance[sKey] || [];
  const existing = db.attendance[sKey].find((a) => a.username === username && a.present);
  if (existing) return res.status(409).json({ error: "تم التسجيل مسبقاً" });
  const record = {
    username,
    sessionId,
    courseId,
    sectionId,
    time: Date.now(),
    device: device || "unknown",
    source,
    present: true
  };
  db.attendance[sKey].push(record);
  db.histories[username] = db.histories[username] || [];
  db.histories[username].push({ ...record, role: "student" });
  await saveDb(db);
  return res.json({ ok: true, attendance: db.attendance[sKey] });
});

app.post("/api/attendance/leave", async (req, res) => {
  const { courseId, sectionId, username } = req.body || {};
  if (!courseId || !sectionId || !username) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const list = (db.attendance && db.attendance[sessionKey(courseId, sectionId)]) || [];
  const rec = list.find((a) => a.username === username && a.present);
  if (!rec) return res.status(404).json({ error: "لم يتم العثور على المستخدم" });
  rec.present = false;
  rec.leftAt = Date.now();
  await saveDb(db);
  return res.json({ ok: true, attendance: list });
});

app.post("/api/attendance/kick", authMiddleware, async (req, res) => {
  const { courseId, sectionId, studentId } = req.body || {};
  if (!courseId || !sectionId || !studentId) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const list = (db.attendance && db.attendance[sessionKey(courseId, sectionId)]) || [];
  const rec = list.find((a) => a.username === studentId && a.present);
  if (!rec) return res.status(404).json({ error: "المستخدم غير موجود في السيكشن" });
  rec.present = false;
  rec.kicked = true;
  rec.leftAt = Date.now();
  await saveDb(db);
  return res.json({ ok: true, attendance: list });
});

app.get("/api/history/:studentId", async (req, res) => {
  const db = await loadDb();
  const list = db.histories[req.params.studentId] || [];
  return res.json({ history: list });
});

app.get("/api/history", authMiddleware, async (req, res) => {
  const db = await loadDb();
  const list = db.histories[req.user.username] || [];
  return res.json({ history: list });
});

app.get("/api/attendance/export", async (req, res) => {
  const { courseId, sectionId } = req.query;
  if (!courseId || !sectionId) return res.status(400).json({ error: "بيانات ناقصة" });
  const db = await loadDb();
  const sKey = sessionKey(courseId, sectionId);
  const session = db.sessions && db.sessions[sKey];
  if (!session) return res.status(400).json({ error: "لا توجد جلسة" });
  const list = (db.attendance && db.attendance[sKey]) || [];
  const rows = [
    ["Session", "CourseId", "SectionId", "Student ID", "Time", "Device", "Source", "Present", "LeftAt", "Kicked"],
    ...list.map((a) => [
      a.sessionId,
      a.courseId,
      a.sectionId,
      a.studentId,
      new Date(a.time).toISOString(),
      a.device,
      a.source,
      a.present,
      a.leftAt ? new Date(a.leftAt).toISOString() : "",
      a.kicked ? "yes" : ""
    ])
  ];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${session.sessionId}.csv"`);
  return res.send(csv);
});

app.get("/api/sessions/active", authMiddleware, async (_req, res) => {
  const db = await loadDb();
  const list = Object.values(db.sessions || {}).filter((s) => s.active);
  const enriched = list.map((s) => {
    const sKey = sessionKey(s.courseId, s.sectionId);
    const att = (db.attendance && db.attendance[sKey]) || [];
    return {
      ...s,
      presentCount: presentCount(att),
      total: 50
    };
  });
  return res.json({ sessions: enriched });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(STATIC_PATH, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Smart Attendance server running on http://localhost:${PORT}`);
});


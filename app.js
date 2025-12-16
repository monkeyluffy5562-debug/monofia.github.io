const API_BASE = location.origin;
const STORAGE_KEYS = { AUTH: "sas_auth" };
const GEMINI_API_KEY = "";

let auth = null;
let courses = [];
let currentCourse = null;
let currentSection = null;
let currentSession = null;
let attendees = [];
let qrScanner = null;
let refreshTimer = null;

const $ = (id) => document.getElementById(id);

const toast = (msg, type = "success") => {
  const box = document.createElement("div");
  box.className = `toast ${type}`;
  box.textContent = msg;
  $("toastContainer").appendChild(box);
  setTimeout(() => box.remove(), 3200);
};

const deviceInfo = () => navigator.userAgent || "unknown device";
const saveAuth = () => localStorage.setItem(STORAGE_KEYS.AUTH, JSON.stringify(auth));
const loadAuth = () => (auth = JSON.parse(localStorage.getItem(STORAGE_KEYS.AUTH) || "null"));

const api = async (path, { method = "GET", body, authRequired = false } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (authRequired && auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || "خطأ غير متوقع");
  return data;
};

// UI helpers
const toggleAppVisibility = (signedIn) => {
  $("loginGate").classList.toggle("hidden", signedIn);
  $("userBar").classList.toggle("hidden", !signedIn);
  $("coursesPanel").classList.toggle("hidden", !signedIn);
  $("sectionPanel").classList.toggle("hidden", !signedIn || !currentCourse);
};

const renderAuth = () => {
  $("currentUser").textContent = auth ? auth.username : "—";
  $("currentRole").textContent = auth ? auth.role : "-";
  $("devPanel").classList.toggle("hidden", auth?.role !== "developer");
  $("devSide").classList.toggle("hidden", auth?.role !== "developer");
  $("lecturerSide").classList.toggle("hidden", auth?.role === "student" || !auth);
  $("devActive").classList.toggle("hidden", auth?.role !== "developer");
  $("sideBar").classList.toggle("hidden", !auth);
  $("exportBtn").classList.toggle("hidden", !auth || auth.role === "student");
  $("lecturerHistoryCard").classList.toggle("hidden", !auth || auth.role === "student");
  toggleAppVisibility(!!auth);
};

const renderCourses = () => {
  const grid = $("coursesGrid");
  grid.innerHTML = "";
  courses.forEach((c) => {
    const card = document.createElement("div");
    card.className = "course-card glass soft";
    card.innerHTML = `<div class="inline"><strong>${c.name}</strong><span class="pill">5 سيكشن</span></div>`;
    const sections = document.createElement("div");
    sections.className = "sections-row";
    c.sections.forEach((s) => {
      const btn = document.createElement("button");
      btn.className = "section-btn";
      btn.textContent = s.name;
      btn.onclick = () => selectSection(c, s);
      sections.appendChild(btn);
    });
    card.appendChild(sections);
    grid.appendChild(card);
  });
};

const updateSessionUI = () => {
  $("selectedCourseName").textContent = currentCourse ? currentCourse.name : "—";
  $("selectedSectionName").textContent = currentSection ? currentSection.name : "—";
  const active = currentSession?.active;
  $("sessionStatusPill").textContent = active ? "محاضرة جارية" : "لا توجد محاضرة";
  $("sessionActiveChip").textContent = active ? "نشطة" : "متوقفة";
  const timeHint = currentSession?.startAt
    ? `من ${new Date(currentSession.startAt).toLocaleTimeString()}${
        currentSession?.endAt ? ` حتى ${new Date(currentSession.endAt).toLocaleTimeString()}` : ""
      }`
    : "";
  $("sessionHint").textContent = active ? `يمكن للطلاب الانضمام الآن. ${timeHint}` : "ابدأ المحاضرة لفتح الحضور.";
  $("sessionCodeDisplay").textContent = active ? currentSession.sessionId : "—";
  $("heroSessionName").textContent = active ? `${currentCourse?.name} - ${currentSection?.name}` : "لا توجد جلسة";
  const isStaff = auth && auth.role !== "student";
  $("heroAttendanceCount").textContent = isStaff ? attendees.filter((a) => a.present).length : "—";
  $("heroCapacityHint").textContent = isStaff ? `من 50 طالب` : "";
  $("showAttendeesBtn").classList.toggle("hidden", !isStaff);
};

const renderAttendance = () => {
  const present = attendees.filter((a) => a.present);
  $("attendeeCountChip").textContent = `${present.length} طالب`;
  const isStaff = auth && auth.role !== "student";
  $("heroAttendanceCount").textContent = isStaff ? present.length : "—";
  const container = $("attendanceList");
  container.innerHTML = "";
  attendees.forEach((a) => {
    const status = a.present ? "تم" : a.kicked ? "تم الطرد" : "غادر";
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `<div>
      <strong>${a.username}</strong>
      <p class="tiny-label">${new Date(a.time).toLocaleTimeString()} · ${a.device || ""}</p>
    </div>
    <span class="badge">${status}</span>`;
    container.appendChild(item);
  });
};

const ensureQr = async (payload) => {
  const holder = $("qrCanvas");
  holder.innerHTML = "";
  if (!payload) {
    holder.textContent = "لا يوجد QR حالياً";
    return;
  }
  const canvas = document.createElement("canvas");
  holder.appendChild(canvas);
  try {
    await QRCode.toCanvas(canvas, payload, { width: 220, margin: 2, color: { dark: "#0c1221", light: "#f8fbff" } });
  } catch (_) {
    holder.textContent = "تعذر إنشاء QR";
  }
};

// Auth
const login = async () => {
  try {
    const username = $("loginUser").value.trim();
    const password = $("loginPass").value.trim();
    if (!username || !password) return toast("أدخل بيانات الدخول", "error");
    const data = await api("/api/login", { method: "POST", body: { username, password } });
    auth = { token: data.token, username: data.username, role: data.role };
    saveAuth();
    renderAuth();
    await loadCourses();
    toast(`تم تسجيل الدخول، أهلاً ${auth.username}`);
  } catch (e) {
    toast(e.message, "error");
  }
};

const logout = () => {
  auth = null;
  saveAuth();
  currentCourse = currentSection = currentSession = null;
  attendees = [];
  renderAttendance();
  renderAuth();
  toast("تم تسجيل الخروج");
};

const createAccount = async () => {
  try {
    if (!auth || auth.role !== "developer") return toast("مصرح للمبرمج فقط", "error");
    const username = $("newUser").value.trim();
    const password = $("newPass").value.trim();
    const role = $("newRole").value;
    const allowedSections = $("newAllowed").value.trim();
    if (!username || !password) return toast("أدخل بيانات الحساب", "error");
    await api("/api/accounts", { method: "POST", body: { username, password, role, allowedSections }, authRequired: true });
    toast("تم إنشاء الحساب");
    $("newUser").value = "";
    $("newPass").value = "";
    $("newAllowed").value = "";
  } catch (e) {
    toast(e.message, "error");
  }
};

// Courses & sections
const loadCourses = async () => {
  try {
    const data = await api("/api/courses");
    courses = data.courses || [];
    renderCourses();
  } catch (e) {
    toast(e.message, "error");
  }
};

const selectSection = async (course, section) => {
  currentCourse = course;
  currentSection = section;
  toggleAppVisibility(true);
  $("sectionPanel").classList.remove("hidden");
  await loadSessionStatus();
  await loadAttendance();
};

// Sessions
const loadSessionStatus = async () => {
  if (!currentCourse || !currentSection) return;
  try {
    const data = await api(`/api/session/status?courseId=${currentCourse.id}&sectionId=${currentSection.id}`);
    if (data.session) {
      currentSession = data.session;
      updateSessionUI();
      await ensureQr(currentSession?.payload);
    }
  } catch (e) {
    toast(e.message, "error");
  }
};

const startSession = async () => {
  if (!auth) return toast("تسجيل الدخول مطلوب", "error");
  if (auth.role === "student") return toast("مصرح للمحاضر/المطور فقط", "error");
  if (!currentCourse || !currentSection) return toast("اختر مادة وسيكشن", "error");
  try {
    const durationMinutes = Number($("durationInput").value || 90);
    currentSession = await api("/api/session/start", {
      method: "POST",
      body: { courseId: currentCourse.id, sectionId: currentSection.id, lecturer: auth.username, durationMinutes },
      authRequired: true
    });
    updateSessionUI();
    await ensureQr(currentSession.payload);
    await loadAttendance();
    toast("تم بدء المحاضرة");
    scheduleAutoRefresh();
  } catch (e) {
    toast(e.message, "error");
  }
};

const endSession = async () => {
  if (!auth) return toast("تسجيل الدخول مطلوب", "error");
  if (auth.role === "student") return toast("مصرح للمحاضر/المطور فقط", "error");
  if (!currentCourse || !currentSection) return;
  try {
    await api("/api/session/end", {
      method: "POST",
      body: { courseId: currentCourse.id, sectionId: currentSection.id },
      authRequired: true
    });
    currentSession = null;
    attendees = [];
    updateSessionUI();
    renderAttendance();
    ensureQr(null);
    toast("تم إنهاء المحاضرة");
    scheduleAutoRefresh();
  } catch (e) {
    toast(e.message, "error");
  }
};

const refreshQr = async () => {
  if (!auth) return toast("تسجيل الدخول مطلوب", "error");
  if (auth.role === "student") return toast("مصرح للمحاضر/المطور فقط", "error");
  if (!currentSession) return toast("لا توجد محاضرة نشطة", "error");
  try {
    currentSession = await api("/api/session/refresh", {
      method: "POST",
      body: { courseId: currentCourse.id, sectionId: currentSection.id },
      authRequired: true
    });
    await ensureQr(currentSession.payload);
    updateSessionUI();
    toast("تم تحديث الـ QR");
  } catch (e) {
    toast(e.message, "error");
  }
};

// Attendance
const loadAttendance = async () => {
  if (!currentCourse || !currentSection) return;
  if (!currentSession || !currentSession.active) return;
  try {
    const data = await api(`/api/attendance?courseId=${currentCourse.id}&sectionId=${currentSection.id}`);
    if (!data || !Array.isArray(data.attendance)) return;
    attendees = data.attendance;
    renderAttendance();
    updateSessionUI();
  } catch (e) {
    toast(e.message, "error");
  }
};

const addAttendance = async (studentId, source = "scan", override = false) => {
  if (!currentSession || !currentSession.active) return toast("المحاضرة غير نشطة", "error");
  if (!studentId) return toast("أدخل اسم المستخدم", "error");
  try {
    // ... داخل الدالة addAttendance
    const result = await api("/api/attendance", {
      method: "POST",
      body: {
        sessionId: currentSession.sessionId,
        courseId: currentCourse.id,
        sectionId: currentSection.id,
        username: studentId,
        source,
        device: deviceInfo(),
        override
      }
    });

    attendees = result.attendance || [];
    // 1. تحديد الطالب الذي قام بالتسجيل للتو (الطالب الذي سجّل حضوره الآن)
    // نفترض أن API سيرجع بيانات الطالب الذي قام بتسجيل الحضور ضمن الـ result
    // أو نعتمد على الـ username الذي تم إرساله
    const attendingStudent = attendees.find(a => a.username === studentId && a.present);

    renderAttendance(); // لتحديث القائمة
    updateSessionUI(); // لتحديث عداد الحضور في الشريط العلوي (Hero)

    // **الخطوة الجديدة:** إخبار الخادم بتحديث ملف التصدير الآن.
    try {
      await api("/api/attendance/update_export", {
        method: "POST",
        body: { courseId: currentCourse.id, sectionId: currentSection.id },
        authRequired: true
      });
    } catch (_) {
      // حتى لو فشل تحديث السجل، لا تمانع واجعل العملية الأساسية لا تفشل
    }

    toast("تم تسجيل الحضور وتحديث ملف السجل", "success");
  } catch (e) {
    toast(e.message, "error");
  }
};

const kickStudent = async () => {
  if (!auth || auth.role === "student") return toast("مصرح للمحاضر/المطور فقط", "error");
  const studentId = $("kickStudentId").value.trim();
  if (!studentId) return toast("أدخل اسم مستخدم", "error");
  try {
    const result = await api("/api/attendance/kick", {
      method: "POST",
      body: { courseId: currentCourse.id, sectionId: currentSection.id, studentId },
      authRequired: true
    });
    attendees = result.attendance || [];
    renderAttendance();
    toast("تم الطرد");
  } catch (e) {
    toast(e.message, "error");
  }
};

const leaveSection = async () => {
  if (!auth) return toast("تسجيل الدخول مطلوب", "error");
  try {
    const result = await api("/api/attendance/leave", {
      method: "POST",
      body: { courseId: currentCourse.id, sectionId: currentSection.id, username: auth.username }
    });
    attendees = result.attendance || [];
    renderAttendance();
    toast("تم تسجيل المغادرة");
  } catch (e) {
    toast(e.message, "error");
  }
};

const exportCsv = () => {
  if (!currentCourse || !currentSection) return toast("اختر مادة وسيكشن", "error");
  window.location.href = `/api/attendance/export?courseId=${currentCourse.id}&sectionId=${currentSection.id}`;
};

// Active sessions for developer
const loadActiveSessions = async () => {
  if (!auth || auth.role !== "developer") return;
  try {
    const data = await api("/api/sessions/active", { authRequired: true });
    const list = data.sessions || [];
    const container = $("activeSessionsList");
    container.innerHTML = "";
    list.forEach((s) => {
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `<div>
        <strong>${s.courseId} - ${s.sectionId}</strong>
        <p class="tiny-label">${s.lecturer} | ${new Date(s.startAt).toLocaleTimeString()} - ${new Date(s.endAt).toLocaleTimeString()}</p>
      </div>
      <span class="badge">${s.presentCount}/50</span>`;
      container.appendChild(item);
    });
  } catch (e) {
    // silent
  }
};

// History for lecturer (sessions created)
const loadMyHistory = async () => {
  if (!auth || auth.role === "student") return toast("مصرح للمحاضر/المطور فقط", "error");
  try {
    const data = await api("/api/history", { authRequired: true });
    const container = $("myHistoryList");
    container.innerHTML = "";
    (data.history || []).slice(-20).reverse().forEach((h) => {
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `<div>
        <strong>${h.courseId || ""} - ${h.sectionId || ""}</strong>
        <p class="tiny-label">${new Date(h.startAt || h.time).toLocaleString()}</p>
      </div>
      <span class="badge">${h.role === "lecturer" ? "محاضر" : "طالب"}</span>`;
      container.appendChild(item);
    });
  } catch (e) {
    toast(e.message, "error");
  }
};

// AI placeholders
const callGemini = async (prompt) => {
  if (!GEMINI_API_KEY) return "أضف مفتاح Gemini API في GEMINI_API_KEY لتفعيل الذكاء الاصطناعي.";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "لم يتم استرجاع رد من الذكاء الاصطناعي.";
};

// QR
const initScanner = () => {
  const config = { fps: 10, qrbox: 200, rememberLastUsedCamera: true };
  try {
    qrScanner = new Html5Qrcode("reader");
    qrScanner.start(
      { facingMode: "environment" },
      config,
      (decoded) => handleScan(decoded),
      () => {}
    );
  } catch (_) {
    const r = $("reader");
    if (r) r.textContent = "تعذر الوصول للكاميرا، يمكنك إدخال الرمز يدويًا.";
  }
};

const handleScan = (decodedText) => {
  let payload;
  try {
    payload = JSON.parse(decodedText);
  } catch (_) {
    payload = { sessionId: decodedText };
  }
  if (!currentSession || !currentSession.active || payload.sessionId !== currentSession.sessionId) {
    return toast("هذا الكود لا يخص السيكشن الحالي", "error");
  }
  if (!auth) return toast("يجب تسجيل الدخول قبل الانضمام", "error");
  addAttendance(auth.username, "qr");
};

// Auto refresh
const scheduleAutoRefresh = () => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (currentCourse && currentSection) {
      await loadSessionStatus();
      if (currentSession?.active) {
        await loadAttendance();
      }
    }
    await loadActiveSessions();
  }, 6000);
};

// Bind
const bindUI = () => {
  $("lecturerTabBtn").onclick = () => switchTab("lecturer");
  $("studentTabBtn").onclick = () => switchTab("student");
  $("startSessionBtn").onclick = startSession;
  $("refreshQrBtn").onclick = refreshQr;
  $("endSessionBtn").onclick = endSession;
  $("manualAddBtn").onclick = () => {
    const id = $("manualStudentId").value.trim();
    addAttendance(id, "manual", true);
  };
  $("exportBtn").onclick = exportCsv;
  $("manualScanBtn").onclick = () => {
    const val = $("manualScanInput").value.trim();
    if (!val) return toast("أدخل الرمز", "error");
    handleScan(val);
  };
  $("showAttendeesBtn").onclick = () => {
    document.getElementById("attendanceList").scrollIntoView({ behavior: "smooth" });
  };
  $("leaveBtn").onclick = leaveSection;
  $("kickBtn").onclick = kickStudent;
  $("loginBtn").onclick = login;
  $("logoutBtn").onclick = logout;
  $("createAccountBtn").onclick = createAccount;
  $("loadMyHistoryBtn").onclick = loadMyHistory;
};

// Tabs visual only (now single panel)
const switchTab = () => {};

// Init
const init = async () => {
  loadAuth();
  renderAuth();
  bindUI();
  if (auth) await loadCourses();
  await loadActiveSessions();
  initScanner();
};

window.addEventListener("DOMContentLoaded", init);


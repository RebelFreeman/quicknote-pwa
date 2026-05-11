const CUSTOM_PRESET = "custom";
const LEGACY_STORAGE_KEY = "quick-reminder-tasks-v1";
const DEVICE_STORAGE_KEY = "quicknote-device-tasks-v2";
const DB_NAME = "quicknote-mobile-db";
const DB_STORE = "kv";
const SW_VERSION = "20260429a";

const state = {
  tasks: [],
  selectedPreset: null,
  selectedReminderAt: null,
  currentPage: "capture",
  lastNotifiedTaskId: null,
  toastTimer: null,
  draftText: "",
  isSaving: false,
  offlineReady: false,
  deviceReady: false,
};

const els = {
  captureForm: document.querySelector("#captureForm"),
  noteInput: document.querySelector("#noteInput"),
  saveBtn: document.querySelector("#saveBtn"),
  customDateWrap: document.querySelector("#customDateWrap"),
  customDate: document.querySelector("#customDate"),
  repeatSelect: document.querySelector("#repeatSelect"),
  manualCategory: document.querySelector("#manualCategory"),
  selectedReminderLabel: document.querySelector("#selectedReminderLabel"),
  permissionBtn: document.querySelector("#permissionBtn"),
  permissionStatus: document.querySelector("#permissionStatus"),
  appStatus: document.querySelector("#appStatus"),
  taskList: document.querySelector("#taskList"),
  archiveList: document.querySelector("#archiveList"),
  activeCount: document.querySelector("#activeCount"),
  archiveCount: document.querySelector("#archiveCount"),
  navActiveCount: document.querySelector("#navActiveCount"),
  toast: document.querySelector("#toast"),
  taskTemplate: document.querySelector("#taskTemplate"),
  pages: Array.from(document.querySelectorAll(".page")),
  navButtons: Array.from(document.querySelectorAll(".nav-button")),
};

init();

async function init() {
  bindEvents();
  syncPermissionStatus();
  render();
  setInitialReminderSelection();
  switchPage("capture");
  startReminderLoop();
  updateAppStatus("正在加载本机备忘…");
  await loadTasks();
  await registerServiceWorker();
  await requestPersistentStorage();
}

function bindEvents() {
  document.querySelectorAll(".preset-button").forEach((button) => {
    button.addEventListener("click", () => selectPreset(button.dataset.preset));
  });

  els.navButtons.forEach((button) => {
    button.addEventListener("click", () => switchPage(button.dataset.pageTarget));
  });

  els.customDate.addEventListener("change", () => {
    if (!els.customDate.value) return;
    state.selectedPreset = CUSTOM_PRESET;
    state.selectedReminderAt = new Date(els.customDate.value).toISOString();
    refreshPresetButtons();
    updateReminderLabel();
  });

  els.noteInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void createTask();
    }
  });

  ["input", "change", "blur", "compositionend"].forEach((eventName) => {
    els.noteInput.addEventListener(eventName, syncDraftText);
  });

  els.captureForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createTask();
  });

  els.saveBtn.addEventListener(
    "touchend",
    (event) => {
      event.preventDefault();
      void createTask();
    },
    { passive: false }
  );

  els.permissionBtn.addEventListener("click", requestNotificationAccess);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      processDueReminders();
      updateStatusText();
    }
  });

  window.addEventListener("online", updateStatusText);
  window.addEventListener("offline", updateStatusText);
}

async function loadTasks() {
  try {
    const [deviceTasks, legacyTasks] = await Promise.all([
      readTasksFromDevice(),
      Promise.resolve(readLegacyTasks()),
    ]);

    state.tasks = mergeTasks(deviceTasks, legacyTasks);
    await writeTasksToDevice(state.tasks);
    writeShadowTasks(state.tasks);
    state.deviceReady = true;
    updateStatusText();
    render();
  } catch {
    state.tasks = mergeTasks(readShadowTasks(), readLegacyTasks());
    state.deviceReady = state.tasks.length > 0;
    updateStatusText();
    render();
  }
}

async function persistTasks() {
  await writeTasksToDevice(state.tasks);
  writeShadowTasks(state.tasks);
  state.deviceReady = true;
  updateStatusText();
}

function setInitialReminderSelection() {
  selectPreset("1h");
}

function selectPreset(preset) {
  state.selectedPreset = preset;
  if (preset === CUSTOM_PRESET) {
    els.customDateWrap.classList.remove("hidden");
    state.selectedReminderAt = els.customDate.value
      ? new Date(els.customDate.value).toISOString()
      : null;
  } else {
    els.customDateWrap.classList.add("hidden");
    state.selectedReminderAt = getPresetDate(preset).toISOString();
  }
  refreshPresetButtons();
  updateReminderLabel();
}

function refreshPresetButtons() {
  document.querySelectorAll(".preset-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.preset === state.selectedPreset);
  });
}

function updateReminderLabel() {
  els.selectedReminderLabel.textContent = state.selectedReminderAt
    ? formatReminderLabel(state.selectedReminderAt)
    : "未选择";
}

function getPresetDate(preset) {
  const now = new Date();
  if (preset === "1h") {
    return new Date(now.getTime() + 60 * 60 * 1000);
  }
  if (preset === "tonight") {
    const tonight = new Date(now);
    tonight.setHours(21, 0, 0, 0);
    if (tonight <= now) tonight.setDate(tonight.getDate() + 1);
    return tonight;
  }
  if (preset === "tomorrow-morning") {
    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(8, 0, 0, 0);
    return tomorrowMorning;
  }
  return now;
}

async function createTask() {
  if (state.isSaving) return;
  state.isSaving = true;

  try {
    els.noteInput.blur();
    await waitForCommit();

    syncDraftText();
    const text = (els.noteInput.value || state.draftText).trim();
    if (!text) {
      els.noteInput.focus();
      showToast("先输入内容");
      return;
    }

    const reminderAt =
      state.selectedReminderAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const manualCategory = els.manualCategory.value;
    const aiMeta = analyzeTask(text);
    const category = manualCategory || aiMeta.category;

    state.tasks.unshift({
      id: createTaskId(),
      text,
      reminderAt,
      repeatMinutes: els.repeatSelect.value === "none" ? null : Number(els.repeatSelect.value),
      category,
      suggestedCategory: aiMeta.category,
      tags: aiMeta.tags,
      status: "active",
      archived: false,
      createdAt: new Date().toISOString(),
      lastTriggeredAt: null,
      notified: false,
    });

    await persistTasks();
    render();
    resetComposer();
    switchPage("tasks");
    showToast("已保存到本机待办");
    processDueReminders();
  } catch (error) {
    console.error("Save failed", error);
    showToast("保存失败，请重试");
  } finally {
    state.isSaving = false;
  }
}

function resetComposer() {
  els.noteInput.value = "";
  state.draftText = "";
  els.manualCategory.value = "";
  els.repeatSelect.value = "none";
  els.customDate.value = "";
  selectPreset("1h");
}

function syncDraftText() {
  state.draftText = els.noteInput.value;
}

function createTaskId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function waitForCommit() {
  return new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
}

function analyzeTask(text) {
  const lowered = text.toLowerCase();
  const rules = [
    { category: "家庭", words: ["妈妈", "爸爸", "家里", "孩子", "家人", "留给我", "做饭", "接送"] },
    { category: "工作", words: ["开会", "客户", "邮件", "汇报", "项目", "老板", "同事"] },
    { category: "购物", words: ["买", "下单", "超市", "菜", "快递", "采购"] },
    { category: "出行", words: ["出门", "地铁", "高铁", "打车", "机场", "带上"] },
    { category: "健康", words: ["药", "医院", "体检", "休息", "喝水", "运动"] },
    { category: "财务", words: ["付款", "报销", "发票", "转账", "账单", "交费"] },
  ];

  const matched = rules.find((rule) => rule.words.some((word) => lowered.includes(word)));
  const category = matched ? matched.category : "其他";
  return { category, tags: extractTags(text, category) };
}

function extractTags(text, category) {
  const tags = new Set([category]);
  ["明天", "今晚", "早上", "下午", "电话", "带上", "回复", "处理", "提醒", "留给我"].forEach((item) => {
    if (text.includes(item)) tags.add(item);
  });
  return Array.from(tags).slice(0, 4);
}

function render() {
  const activeTasks = state.tasks.filter((task) => task.status === "active" && !task.archived);
  const archivedTasks = state.tasks.filter((task) => task.archived);
  els.activeCount.textContent = String(activeTasks.length);
  els.archiveCount.textContent = String(archivedTasks.length);
  els.navActiveCount.textContent = String(activeTasks.length);
  els.navActiveCount.classList.toggle("hidden", activeTasks.length === 0);
  renderTaskList(els.taskList, activeTasks, false);
  renderTaskList(els.archiveList, archivedTasks, true);
}

function renderTaskList(container, tasks, archived) {
  container.innerHTML = "";
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "task-card";
    empty.innerHTML = `<p class="task-text">${archived ? "还没有归档内容。" : "还没有待办，先去记一条。"}</p>`;
    container.append(empty);
    return;
  }

  tasks.forEach((task) => {
    const node = els.taskTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".task-category").textContent = task.category;
    node.querySelector(".task-reminder").textContent = formatReminderLabel(task.reminderAt);
    node.querySelector(".task-text").textContent = task.text;

    const tagRow = node.querySelector(".tag-row");
    task.tags.forEach((tag) => {
      const tagNode = document.createElement("span");
      tagNode.className = "tag-pill";
      tagNode.textContent = `#${tag}`;
      tagRow.append(tagNode);
    });

    const actions = node.querySelector(".task-actions");
    if (!archived) {
      actions.append(
        makeActionButton("完成", "primary", () => markTaskDone(task.id)),
        makeActionButton("延后 30 分钟", "warn", () => snoozeTask(task.id, 30)),
        makeActionButton("归档", "", () => archiveTask(task.id))
      );
    } else {
      actions.append(
        makeActionButton("恢复", "", () => restoreTask(task.id)),
        makeActionButton("删除", "danger", () => deleteTask(task.id))
      );
    }

    container.append(node);
  });
}

function makeActionButton(label, variant, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-button ${variant}`.trim();
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function markTaskDone(taskId) {
  updateTask(taskId, (task) => {
    task.status = "done";
    task.archived = true;
    task.repeatMinutes = null;
    task.notified = true;
  });
}

function archiveTask(taskId) {
  updateTask(taskId, (task) => {
    task.archived = true;
  });
}

function restoreTask(taskId) {
  updateTask(taskId, (task) => {
    task.archived = false;
    if (task.status === "done") task.status = "active";
  });
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter((task) => task.id !== taskId);
  void persistAndRender();
}

function snoozeTask(taskId, minutes) {
  updateTask(taskId, (task) => {
    task.reminderAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    task.lastTriggeredAt = null;
    task.notified = false;
  });
}

function updateTask(taskId, updater) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  updater(task);
  void persistAndRender();
}

function switchPage(page) {
  state.currentPage = page;
  els.pages.forEach((node) => {
    node.classList.toggle("is-active", node.dataset.page === page);
  });
  els.navButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.pageTarget === page);
  });
  if (page === "capture") {
    setTimeout(() => {
      els.noteInput.focus();
    }, 50);
  }
}

function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  els.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove("is-visible");
    els.toast.classList.add("hidden");
  }, 1800);
}

function updateAppStatus(message) {
  if (!els.appStatus) return;
  els.appStatus.textContent = message;
}

function updateStatusText() {
  if (!navigator.onLine) {
    updateAppStatus(
      state.deviceReady
        ? "已保存在本机，离线也能使用"
        : "当前离线，请先在联网时打开一次"
    );
    return;
  }

  if (state.offlineReady && state.deviceReady) {
    updateAppStatus("已保存在本机，可离线使用");
    return;
  }

  if (state.deviceReady) {
    updateAppStatus("已保存在本机");
    return;
  }

  updateAppStatus("已保存在本机");
}

async function persistAndRender() {
  try {
    await persistTasks();
    render();
  } catch (error) {
    console.error("Persist failed", error);
    showToast("保存失败，请重试");
    updateStatusText();
  }
}

function syncPermissionStatus() {
  if (!("Notification" in window)) {
    els.permissionStatus.textContent = "当前浏览器不支持通知";
    return;
  }

  const labels = {
    granted: "通知已开启",
    denied: "通知被拒绝",
    default: "尚未授权",
  };
  els.permissionStatus.textContent = labels[Notification.permission];
}

async function requestNotificationAccess() {
  if (!("Notification" in window)) {
    syncPermissionStatus();
    return;
  }
  await Notification.requestPermission();
  playReminderTone();
  syncPermissionStatus();
}

function startReminderLoop() {
  processDueReminders();
  setInterval(processDueReminders, 15000);
}

function processDueReminders() {
  const now = Date.now();
  let changed = false;

  state.tasks.forEach((task) => {
    if (task.status !== "active" || task.archived) return;
    const dueAt = new Date(task.reminderAt).getTime();
    if (Number.isNaN(dueAt) || dueAt > now) return;
    if (!task.repeatMinutes && task.notified) return;

    const triggeredAt = task.lastTriggeredAt ? new Date(task.lastTriggeredAt).getTime() : 0;
    if (triggeredAt && now - triggeredAt < 60 * 1000) return;

    notifyTask(task);
    task.lastTriggeredAt = new Date().toISOString();
    changed = true;

    if (task.repeatMinutes) {
      task.reminderAt = new Date(now + task.repeatMinutes * 60 * 1000).toISOString();
    } else {
      task.notified = true;
    }
  });

  if (changed) {
    void persistAndRender();
  }
}

function notifyTask(task) {
  playReminderTone();
  if ("Notification" in window && Notification.permission === "granted") {
    const body = task.repeatMinutes
      ? `${task.text} · 将持续每 ${task.repeatMinutes} 分钟提醒`
      : task.text;
    new Notification("提醒你处理这件事", {
      body,
      tag: task.id,
      renotify: true,
    });
    return;
  }

  const fallback = `提醒：${task.text}`;
  if (state.lastNotifiedTaskId !== task.id) {
    alert(fallback);
    state.lastNotifiedTaskId = task.id;
    setTimeout(() => {
      state.lastNotifiedTaskId = null;
    }, 1000);
  }
}

function playReminderTone() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.001;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45);
    oscillator.stop(context.currentTime + 0.48);
    oscillator.addEventListener("ended", () => {
      context.close().catch(() => {});
    });
  } catch {
    // Ignore audio failures when browsers require prior user interaction.
  }
}

function formatReminderLabel(isoString) {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    updateStatusText();
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register(`./sw.js?v=${SW_VERSION}`);
    if (registration.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      state.offlineReady = true;
      updateStatusText();
    });

    await navigator.serviceWorker.ready;
    state.offlineReady = true;
    updateStatusText();
  } catch {
    updateStatusText();
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return;
  try {
    await navigator.storage.persist();
  } catch {
    // Ignore storage persistence failures.
  }
}

async function readTasksFromDevice() {
  if (!("indexedDB" in window)) {
    return readShadowTasks();
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "key" });
      }
    };

    request.onerror = () => {
      resolve(readShadowTasks());
    };

    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);
      const getRequest = store.get("tasks");

      getRequest.onerror = () => {
        db.close();
        resolve(readShadowTasks());
      };

      getRequest.onsuccess = () => {
        const value = getRequest.result?.value;
        db.close();
        resolve(Array.isArray(value) ? value : readShadowTasks());
      };
    };
  });
}

async function writeTasksToDevice(tasks) {
  writeShadowTasks(tasks);

  if (!("indexedDB" in window)) return;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "key" });
      }
    };

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      store.put({ key: "tasks", value: tasks });

      tx.oncomplete = () => {
        db.close();
        resolve();
      };

      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

function readShadowTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeShadowTasks(tasks) {
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Ignore local shadow write failures.
  }
}

function readLegacyTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeTasks(...sources) {
  const merged = new Map();

  sources.flat().forEach((task) => {
    if (!task || typeof task !== "object") return;
    const id = String(task.id || "");
    if (!id) return;
    if (!merged.has(id)) {
      merged.set(id, task);
    }
  });

  return Array.from(merged.values()).sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

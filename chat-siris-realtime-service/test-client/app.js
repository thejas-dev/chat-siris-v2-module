/* global io */

const STORAGE_KEY = "chat-siris-realtime-tester";

/** @type {import("socket.io-client").Socket | null} */
let socket = null;

/** @type {Array<{ id: string, direction: string, event: string, payload: unknown, timestamp: string }>} */
let logEntries = [];

/** @type {Record<string, number>} */
const eventCounts = {};

const INBOUND_EVENTS = [
  "msg-recieve",
  "fetchMessages",
  "fetch",
  "channelUpdate",
  "channelDetailsUpdate",
  "userJoined",
  "server-shutdown",
];

const SYSTEM_EVENTS = ["connect", "disconnect", "connect_error", "reconnect", "reconnect_attempt"];

const EMIT_EVENTS = [
  {
    name: "add-user",
    note: "Payload is a plain string (userId). Must match JWT sub when auth is enabled.",
    payloadType: "string",
    defaultPayload: "YOUR_USER_ID",
  },
  {
    name: "addUserToChannel",
    note: "Joins channel room after membership check. Requires channelRef.name.",
    defaultPayload: { name: "general", id: "chan-1" },
  },
  {
    name: "RemoveUserFromChannel",
    note: "Leaves channel room.",
    defaultPayload: { name: "general" },
  },
  {
    name: "add-member",
    note: "Joins room and emits userJoined to channel.",
    defaultPayload: {
      channelName: "general",
      members: [{ userId: "user-1", name: "Alice" }],
    },
  },
  {
    name: "add-msg",
    note: "Deprecated relay — only works if message _id is in anti-spoof cache (~60s).",
    defaultPayload: {
      group: "general",
      data: {
        status: true,
        data: {
          _id: "674a1b2c3d4e5f6789012345",
          group: "general",
          message: { text: "hello from test client" },
        },
      },
    },
  },
  {
    name: "refetchChannels",
    note: "No payload. Broadcasts fetch to other clients.",
    payloadType: "none",
    defaultPayload: null,
  },
  {
    name: "refetchMessages",
    note: "Emits fetchMessages to room.",
    defaultPayload: { group: "general" },
  },
  {
    name: "channelUpdate",
    note: "Room emit channelDetailsUpdate.",
    defaultPayload: { name: "general", title: "General", members: [] },
  },
];

const els = {
  serverUrl: document.getElementById("server-url"),
  accessToken: document.getElementById("access-token"),
  decodeToken: document.getElementById("decode-token"),
  tokenInfo: document.getElementById("token-info"),
  btnConnect: document.getElementById("btn-connect"),
  btnDisconnect: document.getElementById("btn-disconnect"),
  btnHealth: document.getElementById("btn-health"),
  connectionBadge: document.getElementById("connection-badge"),
  socketId: document.getElementById("socket-id"),
  subscriptionList: document.getElementById("subscription-list"),
  subscriptionCount: document.getElementById("subscription-count"),
  emitForms: document.getElementById("emit-forms"),
  customEventName: document.getElementById("custom-event-name"),
  customEventPayload: document.getElementById("custom-event-payload"),
  btnCustomEmit: document.getElementById("btn-custom-emit"),
  eventLog: document.getElementById("event-log"),
  logFilter: document.getElementById("log-filter"),
  logPause: document.getElementById("log-pause"),
  btnClearLog: document.getElementById("btn-clear-log"),
  btnExportLog: document.getElementById("btn-export-log"),
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.serverUrl) els.serverUrl.value = saved.serverUrl;
    if (saved.accessToken) els.accessToken.value = saved.accessToken;
  } catch {
    /* ignore */
  }
}

function saveSettings() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      serverUrl: els.serverUrl.value.trim(),
      accessToken: els.accessToken.value.trim(),
    }),
  );
}

function defaultServerUrl() {
  return `${window.location.protocol}//${window.location.host}`;
}

function formatTime(date = new Date()) {
  return date.toISOString().split("T")[1].replace("Z", "");
}

function prettyJson(value) {
  if (value === undefined) return "(no payload)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function decodeJwtPayload(token) {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format (expected 3 parts)");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

function setConnectionStatus(status) {
  els.connectionBadge.className = "badge";
  if (status === "connected") {
    els.connectionBadge.classList.add("badge-connected");
    els.connectionBadge.textContent = "Connected";
    els.btnConnect.disabled = true;
    els.btnDisconnect.disabled = false;
  } else if (status === "connecting") {
    els.connectionBadge.classList.add("badge-connecting");
    els.connectionBadge.textContent = "Connecting…";
    els.btnConnect.disabled = true;
    els.btnDisconnect.disabled = true;
  } else {
    els.connectionBadge.classList.add("badge-disconnected");
    els.connectionBadge.textContent = "Disconnected";
    els.btnConnect.disabled = false;
    els.btnDisconnect.disabled = true;
    els.socketId.textContent = "—";
  }
}

function incrementEventCount(event, direction) {
  const key = `${direction}:${event}`;
  eventCounts[key] = (eventCounts[key] || 0) + 1;
  renderSubscriptionList();
}

function renderSubscriptionList() {
  const allEvents = [
    ...INBOUND_EVENTS.map((e) => ({ event: e, direction: "inbound" })),
    ...EMIT_EVENTS.map((e) => ({ event: e.name, direction: "outbound" })),
    ...SYSTEM_EVENTS.map((e) => ({ event: e, direction: "system" })),
  ];

  const activeCount = Object.keys(eventCounts).length;
  els.subscriptionCount.textContent =
    activeCount > 0 ? `${activeCount} received` : `${INBOUND_EVENTS.length + SYSTEM_EVENTS.length} listening`;

  els.subscriptionList.innerHTML = allEvents
    .map(({ event, direction }) => {
      const count = eventCounts[`${direction}:${event}`] || 0;
      return `<li class="event-list-item ${direction}">
        <span class="name">${event}</span>
        <span class="count">${count || "·"}</span>
      </li>`;
    })
    .join("");
}

function addLogEntry(direction, event, payload) {
  const entry = {
    id: crypto.randomUUID(),
    direction,
    event,
    payload,
    timestamp: new Date().toISOString(),
  };

  logEntries.unshift(entry);
  if (logEntries.length > 500) logEntries.length = 500;

  incrementEventCount(event, direction);

  if (!els.logPause.checked) {
    renderLog();
  }
}

function renderLog() {
  const filter = els.logFilter.value.trim().toLowerCase();
  const filtered = filter
    ? logEntries.filter((e) => e.event.toLowerCase().includes(filter))
    : logEntries;

  if (filtered.length === 0) {
    els.eventLog.innerHTML = '<p class="log-empty">No events yet. Connect and emit or wait for incoming events.</p>';
    return;
  }

  els.eventLog.innerHTML = filtered
    .map(
      (entry) => `<article class="log-entry ${entry.direction}" data-id="${entry.id}">
        <div class="log-entry-header">
          <span class="log-entry-time">${formatTime(new Date(entry.timestamp))}</span>
          <span class="log-entry-name">${entry.event}</span>
          <span class="log-entry-dir">${entry.direction}</span>
        </div>
        <pre class="log-entry-payload">${escapeHtml(prettyJson(entry.payload))}</pre>
      </article>`,
    )
    .join("");

  els.eventLog.scrollTop = 0;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resetEventCounts() {
  for (const key of Object.keys(eventCounts)) {
    delete eventCounts[key];
  }
  renderSubscriptionList();
}

function buildEmitForms() {
  els.emitForms.innerHTML = EMIT_EVENTS.map((evt, idx) => {
    const open = idx === 0 ? " open" : "";
    let textarea = "";
    if (evt.payloadType === "none") {
      textarea = `<p class="emit-note">This event has no payload.</p>`;
    } else if (evt.payloadType === "string") {
      textarea = `<textarea id="emit-${evt.name}" spellcheck="false">${escapeHtml(String(evt.defaultPayload))}</textarea>`;
    } else {
      textarea = `<textarea id="emit-${evt.name}" spellcheck="false">${escapeHtml(prettyJson(evt.defaultPayload))}</textarea>`;
    }

    return `<details class="emit-card"${open}>
      <summary>${evt.name}</summary>
      <div class="emit-card-body">
        <p class="emit-note">${evt.note}</p>
        ${textarea}
        <button type="button" class="btn btn-primary btn-emit" data-event="${evt.name}" data-type="${evt.payloadType || "json"}">Emit ${evt.name}</button>
      </div>
    </details>`;
  }).join("");

  els.emitForms.querySelectorAll(".btn-emit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const eventName = btn.dataset.event;
      const payloadType = btn.dataset.type;
      emitEvent(eventName, payloadType);
    });
  });
}

function parseEmitPayload(eventName, payloadType) {
  if (payloadType === "none") return undefined;

  const textarea = document.getElementById(`emit-${eventName}`);
  const raw = textarea.value.trim();

  if (payloadType === "string") {
    return raw;
  }

  if (!raw) return {};
  return JSON.parse(raw);
}

function emitEvent(eventName, payloadType) {
  if (!socket?.connected) {
    addLogEntry("error", "emit-blocked", { reason: "Not connected", event: eventName });
    renderLog();
    return;
  }

  try {
    const payload = parseEmitPayload(eventName, payloadType);
    if (payload === undefined) {
      socket.emit(eventName);
      addLogEntry("outbound", eventName, null);
    } else {
      socket.emit(eventName, payload);
      addLogEntry("outbound", eventName, payload);
    }
  } catch (err) {
    addLogEntry("error", "emit-error", { event: eventName, message: err.message });
    renderLog();
  }
}

function connect() {
  saveSettings();
  const url = els.serverUrl.value.trim() || defaultServerUrl();
  const token = els.accessToken.value.trim();

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  resetEventCounts();
  setConnectionStatus("connecting");

  const options = {
    withCredentials: true,
    extraHeaders: { "my-custom-header": "realtime-test-client" },
  };

  if (token) {
    options.auth = { token };
  }

  socket = io(url, options);

  socket.on("connect", () => {
    setConnectionStatus("connected");
    els.socketId.textContent = socket.id;
    addLogEntry("system", "connect", { socketId: socket.id });
  });

  socket.on("disconnect", (reason) => {
    setConnectionStatus("disconnected");
    addLogEntry("system", "disconnect", { reason });
  });

  socket.on("connect_error", (err) => {
    setConnectionStatus("disconnected");
    addLogEntry("error", "connect_error", { message: err.message });
    renderLog();
  });

  socket.on("reconnect_attempt", (attempt) => {
    addLogEntry("system", "reconnect_attempt", { attempt });
  });

  socket.on("reconnect", (attempt) => {
    addLogEntry("system", "reconnect", { attempt, socketId: socket.id });
    els.socketId.textContent = socket.id;
  });

  socket.onAny((event, ...args) => {
    if (SYSTEM_EVENTS.includes(event)) return;
    addLogEntry("inbound", event, args.length <= 1 ? args[0] ?? null : args);
  });
}

function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  setConnectionStatus("disconnected");
}

async function checkHealth() {
  const url = els.serverUrl.value.trim() || defaultServerUrl();
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`);
    const data = await res.json();
    addLogEntry("system", "health-check", { status: res.status, body: data });
    renderLog();
  } catch (err) {
    addLogEntry("error", "health-check", { message: err.message });
    renderLog();
  }
}

function init() {
  els.serverUrl.value = defaultServerUrl();
  loadSettings();
  buildEmitForms();
  renderSubscriptionList();
  renderLog();

  els.btnConnect.addEventListener("click", connect);
  els.btnDisconnect.addEventListener("click", disconnect);
  els.btnHealth.addEventListener("click", checkHealth);

  els.decodeToken.addEventListener("click", () => {
    const token = els.accessToken.value.trim();
    if (!token) {
      els.tokenInfo.classList.add("hidden");
      return;
    }
    try {
      const payload = decodeJwtPayload(token);
      els.tokenInfo.textContent = prettyJson(payload);
      els.tokenInfo.classList.remove("hidden");
      if (payload.sub) {
        const addUserField = document.getElementById("emit-add-user");
        if (addUserField && addUserField.value === "YOUR_USER_ID") {
          addUserField.value = payload.sub;
        }
      }
    } catch (err) {
      els.tokenInfo.textContent = `Decode error: ${err.message}`;
      els.tokenInfo.classList.remove("hidden");
    }
  });

  els.btnCustomEmit.addEventListener("click", () => {
    const name = els.customEventName.value.trim();
    if (!name) return;
    try {
      const raw = els.customEventPayload.value.trim();
      const payload = raw ? JSON.parse(raw) : {};
      if (!socket?.connected) {
        addLogEntry("error", "emit-blocked", { reason: "Not connected", event: name });
        renderLog();
        return;
      }
      socket.emit(name, payload);
      addLogEntry("outbound", name, payload);
    } catch (err) {
      addLogEntry("error", "emit-error", { event: els.customEventName.value, message: err.message });
      renderLog();
    }
  });

  els.logFilter.addEventListener("input", renderLog);
  els.logPause.addEventListener("change", () => {
    if (!els.logPause.checked) renderLog();
  });

  els.btnClearLog.addEventListener("click", () => {
    logEntries = [];
    resetEventCounts();
    renderLog();
  });

  els.btnExportLog.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(logEntries, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `realtime-events-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  [els.serverUrl, els.accessToken].forEach((el) => {
    el.addEventListener("change", saveSettings);
  });
}

init();

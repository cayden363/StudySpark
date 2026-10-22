const socket = io();
const $ = (id) => document.getElementById(id);
const tokenKey = "studyspark-session-token";
let token = localStorage.getItem(tokenKey);
if (!token) {
  token = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-f0-9-]/gi, "");
  localStorage.setItem(tokenKey, token);
}
let currentUsername = "Student";
let nextNameChangeAt = 0;
let users = [];
let isMod = false;
let currentLinks = [];
let contextTarget = null;
let toastTimer;
const esc = (s) => String(s ?? "");
const initials = (name) => esc(name).trim().slice(0, 1).toUpperCase() || "S";
const time = (stamp) => new Date(stamp).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3300);
}
function setConnected(ok) {
  $("connectionState").textContent = ok ? "connected" : "reconnecting";
  $("connectionState").parentElement.classList.toggle("connected", ok);
}
function activateTab(name) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === `panel-${name}`));
  hideContextMenu();
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => activateTab(b.dataset.tab)));
socket.on("connect", () => { setConnected(true); socket.emit("hello", {token}); });
socket.on("disconnect", () => setConnected(false));
socket.on("connect_error", () => setConnected(false));
socket.on("init", data => {
  currentUsername = data.username;
  nextNameChangeAt = data.nextNameChangeAt || 0;
  $("currentUsername").textContent = currentUsername;
  $("bigAvatar").textContent = initials(currentUsername);
  $("usernameInput").value = currentUsername;
  renderMessages(data.messages || []);
    currentLinks = data.links || [];
  renderLinks(currentLinks);
  renderUsers(data.users || []);
  updateCooldown();
});
socket.on("message", item => appendMessage(item));
socket.on("system", item => {
  const node = document.createElement("div");
  node.className = "system-message";
  node.textContent = `${item.text} · ${time(item.time)}`;
  $("messages").appendChild(node);
  trimMessages();
  $("messages").scrollTop = $("messages").scrollHeight;
});
socket.on("users", renderUsers);
socket.on("links", items => {
  currentLinks = items || [];
  renderLinks(currentLinks);
});
socket.on("notice", data => toast(data.text));
socket.on("usernameChanged", data => {
  currentUsername = data.username;
  nextNameChangeAt = data.nextNameChangeAt;
  $("currentUsername").textContent = currentUsername;
  $("bigAvatar").textContent = initials(currentUsername);
  $("usernameInput").value = currentUsername;
  updateCooldown();
  toast("Username updated!");
});
socket.on("modLoginSuccess", () => {
  isMod = true;
   renderLinks(currentLinks);
  $("modLoginBox").classList.add("hidden");
  $("modTools").classList.remove("hidden");
  toast("Moderator tools unlocked.");
});
socket.on("muted", data => {
  const input = $("chatInput");
  input.disabled = true;
  input.placeholder = `Muted until ${new Date(data.until).toLocaleTimeString()}`;
  toast("A moderator muted you for one hour.");
  setTimeout(() => { input.disabled = false; input.placeholder = "Send a message to everyone…"; toast("Your mute has ended."); }, Math.max(0, data.until - Date.now()));
});

$("chatForm").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("chatInput");
  const value = input.value.trim();
  if (!value) return;
  socket.emit("chat", value);
  input.value = "";
  input.focus();
});
$("usernameForm").addEventListener("submit", e => {
  e.preventDefault();
  socket.emit("setUsername", $("usernameInput").value);
});
$("linkForm").addEventListener("submit", e => {
  e.preventDefault();
  socket.emit("shareLink", {title: $("linkTitle").value, url: $("linkUrl").value});
  $("linkTitle").value = "";
  $("linkUrl").value = "";
});
$("modForm").addEventListener("submit", e => {
  e.preventDefault();
  socket.emit("modLogin", $("modPassword").value);
  $("modPassword").value = "";
});
$("modLogout").addEventListener("click", () => {
  // Server-side moderator permission remains tied to this session; disconnect/reconnect to fully clear it.
  socket.disconnect(); socket.connect();
  isMod = false;
  $("modLoginBox").classList.remove("hidden");
  $("modTools").classList.add("hidden");
  toast("Moderator panel locked for this page session.");
});

function appendMessage(item) {
  const row = document.createElement("div"); row.className = "message";
  const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = initials(item.username);
  const body = document.createElement("div"); body.className = "message-body";
  const meta = document.createElement("div"); meta.className = "message-meta";
  const name = document.createElement("span"); name.className = "message-name"; name.textContent = item.username;
  const stamp = document.createElement("span"); stamp.className = "message-time"; stamp.textContent = time(item.time);
  const text = document.createElement("div"); text.className = "message-text"; text.textContent = item.text;
  meta.append(name, stamp); body.append(meta, text); row.append(avatar, body); $("messages").appendChild(row);
  trimMessages(); $("messages").scrollTop = $("messages").scrollHeight;
}
function renderMessages(items) {
  $("messages").replaceChildren();
  if (!items.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "You're early! Say hello to start the conversation."; $("messages").appendChild(empty); return; }
  items.forEach(appendMessage);
}
function trimMessages() { while ($("messages").children.length > 120) $("messages").firstElementChild.remove(); }
function renderUsers(list) {
  users = list || [];
  $("onlineCount").textContent = users.length;
  $("memberCount").textContent = users.length;
  const root = $("userList"); root.replaceChildren();
  if (!users.length) { root.textContent = "Nobody online yet."; return; }
  users.forEach(user => {
    const row = document.createElement("div"); row.className = "user-row"; row.dataset.userId = user.id;
    const av = document.createElement("div"); av.className = "avatar"; av.textContent = initials(user.username);
    const name = document.createElement("span"); name.className = "user-name"; name.textContent = user.username;
    row.append(av, name);
    if (user.username === currentUsername) { const you = document.createElement("span"); you.className = "you-tag"; you.textContent = "you"; row.appendChild(you); }
    if (user.muted) { const muted = document.createElement("span"); muted.className = "muted-badge"; muted.textContent = "muted"; row.appendChild(muted); }
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!isMod || user.username === currentUsername) return;
      contextTarget = user.id;
      const menu = $("contextMenu");
      menu.style.left = `${Math.min(e.clientX, window.innerWidth - 190)}px`;
      menu.style.top = `${Math.min(e.clientY, window.innerHeight - 65)}px`;
      menu.classList.remove("hidden");
    });
    root.appendChild(row);
  });
}
$("muteAction").addEventListener("click", () => {
  if (contextTarget) socket.emit("muteUser", contextTarget);
  hideContextMenu();
});
function hideContextMenu() { $("contextMenu").classList.add("hidden"); contextTarget = null; }
document.addEventListener("click", e => { if (!$("contextMenu").contains(e.target)) hideContextMenu(); });
window.addEventListener("scroll", hideContextMenu, true);
function renderLinks(items) {
  const root = $("links"); root.replaceChildren();
  if (!items.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "No websites shared yet. Add the first one!"; root.appendChild(empty); return; }
  items.forEach(item => {
    const card = document.createElement("article"); card.className = "link-card";
    const top = document.createElement("div"); top.className = "link-card-top";
    const icon = document.createElement("div"); icon.className = "link-icon"; icon.textContent = "↗";
    const copy = document.createElement("div");
    const title = document.createElement("h3"); title.textContent = item.title;
    const link = document.createElement("a"); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = new URL(item.url).hostname;
    copy.append(title, link); top.append(icon, copy);
        const by = document.createElement("div");
    by.className = "link-by";
    by.textContent = `Shared by ${item.username} · ${time(item.time)}`;

    card.append(top, by);

    if (isMod) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => {
        if (confirm(`Delete "${item.title}" for everyone?`)) {
          socket.emit("deleteLink", item.id);
        }
      });
      card.appendChild(deleteButton);
    }

    root.appendChild(card);
  });
}
function updateCooldown() {
  const remaining = nextNameChangeAt - Date.now();
  if (remaining > 0) {
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    $("cooldownText").textContent = `You can change it again in ${minutes}m ${seconds}s.`;
    $("cooldownText").classList.add("cooldown");
  } else {
    $("cooldownText").textContent = "You can change your username once every 10 minutes.";
    $("cooldownText").classList.remove("cooldown");
  }
}
setInterval(updateCooldown, 1000);

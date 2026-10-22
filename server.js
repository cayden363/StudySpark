const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16_000 });
const PORT = Number(process.env.PORT || 3000);
const MOD_PASSWORD = process.env.MOD_PASSWORD;

if (!MOD_PASSWORD || MOD_PASSWORD.length < 12) {
  console.warn("WARNING: Set MOD_PASSWORD to a private password at least 12 characters long before public deployment.");
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const users = new Map();       // socket id -> user session
const identities = new Map();  // random browser token -> username/cooldown/mod state
const messages = [];
const sharedLinks = [];
const mutedUntil = new Map();  // identity token -> timestamp
const MAX_MESSAGES = 100;
const MAX_LINKS = 100;
const NAME_COOLDOWN = 10 * 60 * 1000;
const MUTE_DURATION = 60 * 60 * 1000;
const cleanText = (s, max) => String(s ?? "").trim().slice(0, max);
const validUrl = (raw) => {
  try {
    const u = new URL(raw);
    return ["http:", "https:"].includes(u.protocol) ? u.href : null;
  } catch { return null; }
};

function getIdentity(token) {
  if (typeof token !== "string" || !/^[a-f0-9-]{24,80}$/i.test(token)) return null;
  if (!identities.has(token)) identities.set(token, {
    username: "Student" + crypto.randomInt(100, 1000),
    lastNameChange: 0,
    isMod: false
  });
  return identities.get(token);
}
function publicUsers() {
  return [...users.values()].map(u => ({
    id: u.socketId, username: u.identity.username,
    muted: (mutedUntil.get(u.token) || 0) > Date.now()
  }));
}
function sendSystem(text) {
  io.emit("system", { text, time: Date.now() });
}
function errorTo(socket, text) { socket.emit("notice", { text }); }

io.on("connection", (socket) => {
  socket.on("hello", (payload = {}) => {
    const token = cleanText(payload.token, 80);
    const identity = getIdentity(token);
    if (!identity) return errorTo(socket, "Could not create your session. Refresh the page.");
    const previous = users.get(socket.id);
    if (previous) users.delete(socket.id);
    users.set(socket.id, { socketId: socket.id, token, identity, isMod: false });
    socket.data.token = token;
    socket.emit("init", {
      username: identity.username,
      nextNameChangeAt: identity.lastNameChange ? identity.lastNameChange + NAME_COOLDOWN : 0,
      messages, links: sharedLinks, users: publicUsers()
    });
    io.emit("users", publicUsers());
  });

  socket.on("setUsername", (rawName) => {
    const user = users.get(socket.id);
    if (!user) return errorTo(socket, "Please reconnect and try again.");
    const name = cleanText(rawName, 20);
    if (!/^[\p{L}\p{N}_ -]{2,20}$/u.test(name)) {
      return errorTo(socket, "Use 2–20 letters, numbers, spaces, underscores, or hyphens.");
    }
    const now = Date.now();
    const readyAt = user.identity.lastNameChange + NAME_COOLDOWN;
    if (user.identity.lastNameChange && now < readyAt) {
      return errorTo(socket, `You can change your username again in ${Math.ceil((readyAt - now) / 60000)} minute(s).`);
    }
    if ([...users.values()].some(other => other.socketId !== socket.id &&
        other.identity.username.toLowerCase() === name.toLowerCase())) {
      return errorTo(socket, "That username is currently in use.");
    }
    user.identity.username = name;
    user.identity.lastNameChange = now;
    socket.emit("usernameChanged", { username: name, nextNameChangeAt: now + NAME_COOLDOWN });
    io.emit("users", publicUsers());
    sendSystem(`${name} joined the room.`);
  });

  socket.on("chat", (raw) => {
    const user = users.get(socket.id);
    if (!user) return;
    const until = mutedUntil.get(user.token) || 0;
    if (until > Date.now()) return errorTo(socket, `You are muted until ${new Date(until).toLocaleTimeString()}.`);
    const text = cleanText(raw, 500);
    if (!text) return;
    const now = Date.now();
    if (socket.data.lastChatAt && now - socket.data.lastChatAt < 600) {
      return errorTo(socket, "Please slow down a little.");
    }
    socket.data.lastChatAt = now;
    const item = { id: crypto.randomUUID(), username: user.identity.username, text, time: now };
    messages.push(item);
    if (messages.length > MAX_MESSAGES) messages.shift();
    io.emit("message", item);
  });

  socket.on("shareLink", (payload = {}) => {
    const user = users.get(socket.id);
    if (!user) return;
    const title = cleanText(payload.title, 80);
    const url = validUrl(cleanText(payload.url, 500));
    if (!title || !url) return errorTo(socket, "Enter a title and a valid http:// or https:// website.");
    const item = { id: crypto.randomUUID(), title, url, username: user.identity.username, time: Date.now() };
    sharedLinks.unshift(item);
    if (sharedLinks.length > MAX_LINKS) sharedLinks.pop();
    io.emit("links", sharedLinks);
  });

  socket.on("modLogin", (password) => {
    const user = users.get(socket.id);
    const supplied = Buffer.from(String(password || ""));
    const expected = Buffer.from(MOD_PASSWORD || "");
    const matches = !!MOD_PASSWORD && supplied.length === expected.length &&
      crypto.timingSafeEqual(supplied, expected);
    if (!user || !matches) return errorTo(socket, "Incorrect moderator password.");
    user.isMod = true;
    socket.emit("modLoginSuccess");
  });

  socket.on("muteUser", (targetSocketId) => {
    const moderator = users.get(socket.id);
    const target = users.get(String(targetSocketId || ""));
    if (!moderator || !moderator.isMod) return errorTo(socket, "Moderator access required.");
    if (!target) return errorTo(socket, "That user is no longer online.");
    if (target.identity.isMod) return errorTo(socket, "Moderators cannot mute another moderator.");
    const until = Date.now() + MUTE_DURATION;
    mutedUntil.set(target.token, until);
    io.to(target.socketId).emit("muted", { until });
    io.emit("users", publicUsers());
    sendSystem(`${target.identity.username} was muted for one hour by a moderator.`);
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    users.delete(socket.id);
    io.emit("users", publicUsers());
    if (user) sendSystem(`${user.identity.username} left the room.`);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, until] of mutedUntil) if (until <= now) mutedUntil.delete(token);
}, 30_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`StudySpark running on http://localhost:${PORT}`);
});
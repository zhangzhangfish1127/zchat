var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ---------------------------------------------------------------------------
// 常量与安全工具
// ---------------------------------------------------------------------------
var MAX_TEXT_LENGTH = 4000;
var MAX_AVATAR_LENGTH = 24000;
var HISTORY_LIMIT = 100;
var DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

function sanitizeAvatar(value) {
  var avatar = typeof value === "string" ? value : "";
  if (!avatar) return "";
  if (avatar.slice(0, 11).toLowerCase() === "data:image/") {
    // 只接受位图 dataURL，杜绝 svg 之类的可执行内容
    return DATA_IMAGE_RE.test(avatar) && avatar.length <= MAX_AVATAR_LENGTH ? avatar : "";
  }
  if (/^https?:\/\//i.test(avatar)) {
    return avatar.length <= 400 ? avatar : "";
  }
  return avatar.slice(0, 8);
}

function sanitizeRoomId(value) {
  var room = typeof value === "string" ? value : "";
  room = room.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return room || "hall";
}

// ---------------------------------------------------------------------------
// Backend: 每个会话 rooms 对应一个独立的 Durable Object 实例
// ---------------------------------------------------------------------------
var ChatRoom = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    var name = state && state.id && state.id.name ? state.id.name : "room:hall";
    this.room = name.indexOf("room:") === 0 ? name.slice(5) : name;
    this.sessions = [];
    this.previews = [];
    this.lastTimestamps = new Map();
  }

  async fetch(request) {
    var url = new URL(request.url);
    var preview = url.searchParams.get("preview") === "1";

    if (request.headers.get("Upgrade") !== "websocket") {
      var info = await this.getInfo();
      return new Response(JSON.stringify(info), {
        headers: { "content-type": "application/json;charset=UTF-8" },
      });
    }

    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server, preview);
    return new Response(null, { status: 101, webSocket: client });
  }

  async getInfo() {
    var messages = (await this.state.storage.get("messages")) || [];
    var last = messages.length ? messages[messages.length - 1] : null;
    return {
      room: this.room,
      online: this.onlineCount(),
      total: messages.length,
      last: last
        ? {
            messageId: last.messageId,
            id: last.id,
            name: last.name,
            text: last.text,
            timestamp: last.timestamp,
            isRetracted: last.isRetracted,
          }
        : null,
    };
  }

  onlineCount() {
    var ids = new Set();
    this.sessions.forEach(function (s) {
      if (s.identified && s.id) ids.add(s.id);
    });
    return ids.size;
  }

  async loadAvatars(ids) {
    var map = {};
    var unique = Array.from(new Set(ids.filter(Boolean)));
    if (!unique.length) return map;
    var keys = unique.map(function (id) {
      return "avatar:" + id;
    });
    var result = await this.state.storage.get(keys);
    if (result && typeof result.forEach === "function") {
      result.forEach(function (value, key) {
        if (value) map[String(key).slice(7)] = value;
      });
    }
    return map;
  }

  async handleSession(ws, preview) {
    ws.accept();

    // 预览连接：只用于左侧会话列表的摘要与未读数，不算成员、不广播加入/离开
    if (preview) {
      var info = await this.getInfo();
      try {
        ws.send(JSON.stringify({ type: "preview", room: this.room, info: info }));
      } catch (e) {}
      this.previews.push(ws);
      var cleanup = () => {
        this.previews = this.previews.filter(function (item) {
          return item !== ws;
        });
      };
      ws.addEventListener("close", cleanup);
      ws.addEventListener("error", cleanup);
      return;
    }

    var session = { ws: ws, quit: false, identified: false, id: "", name: "", avatar: "" };
    this.sessions.push(session);

    var history = (await this.state.storage.get("messages")) || [];
    var avatars = await this.loadAvatars(
      history.map(function (m) {
        return m.id;
      })
    );
    ws.send(
      JSON.stringify({
        type: "history",
        room: this.room,
        messages: history,
        avatars: avatars,
        online: this.onlineCount(),
      })
    );

    await this.updateAndBroadcastStatus();

    ws.addEventListener("message", async (msg) => {
      try {
        if (session.quit) return;

        var data = JSON.parse(msg.data);

        if (data.type === "identity") {
          var firstTime = !session.identified;
          session.id = String(data.id || crypto.randomUUID()).slice(0, 64);
          session.name = String(data.name || this.generateName()).slice(0, 20);
          session.avatar = sanitizeAvatar(data.avatar);
          session.identified = true;

          var stored = await this.state.storage.get("avatar:" + session.id);
          if (!stored || stored.name !== session.name || stored.avatar !== session.avatar) {
            await this.state.storage.put("avatar:" + session.id, {
              name: session.name,
              avatar: session.avatar,
            });
            this.broadcast({
              type: "peer",
              user: { id: session.id, name: session.name, avatar: session.avatar },
            });
          }

          ws.send(
            JSON.stringify({
              type: "identity",
              id: session.id,
              name: session.name,
              avatar: session.avatar,
              room: this.room,
            })
          );

          if (firstTime) {
            ws.send(JSON.stringify({ type: "info", message: "欢迎你, " + session.name + "!" }));
            this.broadcast({ type: "info", message: session.name + " 加入了聊天。" }, session.id);
          }
          await this.updateAndBroadcastStatus();
          return;
        }

        if (!session.identified) {
          ws.send(JSON.stringify({ type: "error", message: "请先设置身份再发送消息！" }));
          return;
        }

        if (data.type === "typing") {
          this.broadcast({ type: "typing", name: session.name, id: session.id }, session.id);
          return;
        }

        if (data.type === "retract") {
          var messageId = data.messageId;
          var currentHistory = (await this.state.storage.get("messages")) || [];
          var messageIndex = currentHistory.findIndex(function (m) {
            return m.messageId === messageId;
          });

          if (messageIndex > -1) {
            var messageToRetract = currentHistory[messageIndex];
            if (
              messageToRetract.id === session.id &&
              Date.now() - messageToRetract.timestamp < 120000
            ) {
              currentHistory[messageIndex].text = "此消息已被撤回";
              currentHistory[messageIndex].isRetracted = true;
              await this.state.storage.put("messages", currentHistory);
              this.broadcast({ type: "retract", messageId: messageId });
              this.pushPreview(currentHistory[messageIndex]);
            } else {
              ws.send(JSON.stringify({ type: "error", message: "无法撤回此消息（超时或权限不足）。" }));
            }
          }
          return;
        }

        if (data.type === "clear") {
          // 清空当前房间的全部聊天记录（对所有人生效）
          await this.state.storage.put("messages", []);
          this.broadcast({ type: "cleared", room: this.room });
          await this.updateAndBroadcastStatus();
          this.clearPreview();
          return;
        }

        if (data.type === "chat") {
          var text = String(data.text == null ? "" : data.text).trim();
          if (!text) return;
          if (text.length > MAX_TEXT_LENGTH) {
            ws.send(JSON.stringify({ type: "error", message: "消息过长，请精简后再发送。" }));
            return;
          }

          var now = Date.now();
          var last = this.lastTimestamps.get(ws) || 0;
          if (now - last < 500) {
            ws.send(JSON.stringify({ type: "error", message: "你说话太快了！" }));
            return;
          }
          this.lastTimestamps.set(ws, now);

          var today = new Date().toISOString().split("T")[0];
          var lastWriteDate = (await this.state.storage.get("lastWriteDate")) || today;
          var dailyWrites = (await this.state.storage.get("dailyWrites")) || 0;
          if (today !== lastWriteDate) {
            dailyWrites = 0;
            await this.state.storage.put("lastWriteDate", today);
          }
          if (dailyWrites >= 100000) {
            ws.send(JSON.stringify({ type: "error", message: "今天的话题已聊完，明天再来吧！" }));
            return;
          }

          var message = {
            messageId: crypto.randomUUID(),
            id: session.id,
            name: session.name,
            text: text,
            timestamp: now,
            isRetracted: false,
          };

          var currentHistory2 = (await this.state.storage.get("messages")) || [];
          currentHistory2.push(message);
          while (currentHistory2.length > HISTORY_LIMIT) {
            currentHistory2.shift();
          }

          await this.state.storage.transaction(async (txn) => {
            await txn.put("messages", currentHistory2);
            await txn.put("dailyWrites", dailyWrites + 1);
          });

          this.broadcast({ type: "message", ...message, avatar: session.avatar });
          this.pushPreview(message);
          await this.updateAndBroadcastStatus();
        }
      } catch (e) {
        // 忽略单条消息的异常，避免整个连接失效
      }
    });

    const closeOrErrorHandler = __name(() => {
      if (!session.quit) {
        session.quit = true;
        this.sessions = this.sessions.filter(function (s) {
          return s !== session;
        });
        this.lastTimestamps.delete(ws);
        if (session.identified) {
          this.broadcast({ type: "info", message: session.name + " 离开了。" });
          this.updateAndBroadcastStatus();
        }
      }
    }, "closeOrErrorHandler");

    ws.addEventListener("close", closeOrErrorHandler);
    ws.addEventListener("error", closeOrErrorHandler);
  }

  broadcast(message, excludeId = null) {
    var preparedMessage = JSON.stringify(message);
    this.sessions = this.sessions.filter(function (session) {
      if (!session.identified) return true;
      if (excludeId && session.id === excludeId) return true;
      try {
        session.ws.send(preparedMessage);
        return true;
      } catch (err) {
        session.quit = true;
        return false;
      }
    });
  }

  pushPreview(message) {
    var payload = JSON.stringify({
      type: "preview-update",
      room: this.room,
      message: message,
    });
    this.previews = this.previews.filter(function (ws) {
      try {
        ws.send(payload);
        return true;
      } catch (err) {
        return false;
      }
    });
  }

  clearPreview() {
    var payload = JSON.stringify({ type: "preview-cleared", room: this.room });
    this.previews = this.previews.filter(function (ws) {
      try {
        ws.send(payload);
        return true;
      } catch (err) {
        return false;
      }
    });
  }

  async updateAndBroadcastStatus() {
    var today = new Date().toISOString().split("T")[0];
    var lastWriteDate = (await this.state.storage.get("lastWriteDate")) || today;
    var dailyWrites = (await this.state.storage.get("dailyWrites")) || 0;
    if (today !== lastWriteDate) {
      dailyWrites = 0;
    }
    var remaining = 100000 - dailyWrites;
    var onlineCount = this.onlineCount();
    var statusMessage = JSON.stringify({
      type: "status",
      online: onlineCount,
      remaining: remaining > 0 ? remaining : 0,
    });
    this.sessions.forEach(function (session) {
      try {
        if (!session.quit) session.ws.send(statusMessage);
      } catch (err) {
        session.quit = true;
      }
    });
    this.sessions = this.sessions.filter(function (s) {
      return !s.quit;
    });
  }

  generateName() {
    var adjectives = ["神秘的", "快乐的", "沉思的", "勇敢的", "聪明的", "好奇的"];
    var nouns = ["访客", "旅人", "思想家", "探险家", "梦想家", "观察者"];
    var randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
    var randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    var randomNum = Math.floor(Math.random() * 9000) + 1000;
    return randomAdj + randomNoun + "_" + randomNum;
  }
};
__name(ChatRoom, "ChatRoom");

var src_default = {
  async fetch(request, env) {
    try {
      var url = new URL(request.url);

      if (request.headers.get("Upgrade") === "websocket") {
        var room = sanitizeRoomId(url.searchParams.get("room"));
        // 默认的「大厅」沿用旧版的全局房间，保留历史消息
        var doName = room === "hall" ? "global-chat-room" : "room:" + room;
        var id = env.CHAT_ROOM.idFromName(doName);
        var stub = env.CHAT_ROOM.get(id);
        return stub.fetch(request);
      }

      if (url.pathname === "/api/info") {
        var roomId = sanitizeRoomId(url.searchParams.get("room"));
        var infoName = roomId === "hall" ? "global-chat-room" : "room:" + roomId;
        var stubInfo = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(infoName));
        var res = await stubInfo.fetch(new Request("https://room.local/?room=" + roomId));
        return new Response(await res.text(), {
          headers: { "content-type": "application/json;charset=UTF-8" },
        });
      }

      return new Response(HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    } catch (e) {
      return new Response(e.message);
    }
  },
};

var HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>ZChat · 聊天室</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js"></script>
<style>
:root {
  --green: #07c160;
  --green-dark: #06ad56;
  --bubble: #95ec69;
  --bg: #f5f5f5;
  --sidebar-bg: #f7f7f7;
  --line: #e6e6e6;
  --text: #191919;
  --muted: #9c9c9c;
  --panel: #fff;
  --hover: #ececec;
  --active: #e6f2e0;
  --danger: #fa5151;
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
  background: #e9e9e9;
  color: var(--text);
  overflow: hidden;
  font-size: 14px;
}
img { display: block; }
button { font-family: inherit; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: rgba(0,0,0,.16); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,.28); }
::-webkit-scrollbar-track { background: transparent; }

/* ---------- 布局 ---------- */
.app { display: flex; height: 100vh; height: 100dvh; width: 100%; background: var(--panel); }
.sidebar {
  width: 286px; flex: 0 0 286px; background: var(--sidebar-bg);
  border-right: 1px solid var(--line); display: flex; flex-direction: column;
  transition: margin-left .26s cubic-bezier(.4,0,.2,1), transform .26s cubic-bezier(.4,0,.2,1);
  z-index: 30;
}
.app.collapsed .sidebar { margin-left: -286px; }
.chat { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: var(--bg); }

/* ---------- 侧栏 ---------- */
.sidebar-top { display: flex; align-items: center; gap: 8px; padding: 18px 14px 10px; }
.me-card {
  display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0;
  padding: 5px; border-radius: 6px; cursor: pointer; transition: background .15s;
}
.me-card:hover { background: var(--hover); }
.me-info { min-width: 0; }
.me-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-id { font-size: 11px; color: var(--muted); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon-btn {
  border: none; background: transparent; cursor: pointer; color: #6b6b6b;
  width: 32px; height: 32px; border-radius: 6px; font-size: 17px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center; transition: background .15s, color .15s;
}
.icon-btn:hover { background: var(--hover); color: var(--text); }

.search-box { padding: 0 14px 10px; }
.search-box input {
  width: 100%; border: none; background: #ececec; border-radius: 6px;
  padding: 7px 11px; font-size: 13px; outline: none; color: var(--text);
}
.search-box input::placeholder { color: #a3a3a3; }

.conv-scroll { flex: 1 1 auto; overflow-y: auto; padding: 2px 8px 10px; }
.conv-group {
  font-size: 11px; color: var(--muted); padding: 12px 8px 6px; letter-spacing: .3px;
  display: flex; align-items: center; justify-content: space-between;
}
.conv-item {
  display: flex; align-items: center; gap: 10px; padding: 9px 8px; border-radius: 6px;
  cursor: pointer; transition: background .12s; position: relative;
}
.conv-item:hover { background: var(--hover); }
.conv-item.active { background: var(--active); }
.conv-main { flex: 1 1 auto; min-width: 0; }
.conv-row { display: flex; align-items: center; gap: 6px; }
.conv-name { flex: 1 1 auto; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-time { font-size: 11px; color: #b2b2b2; flex-shrink: 0; }
.conv-snippet { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge {
  min-width: 17px; height: 17px; padding: 0 5px; border-radius: 9px; background: var(--danger);
  color: #fff; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.sidebar-foot { padding: 10px 14px 16px; border-top: 1px solid var(--line); }
.new-room-btn {
  width: 100%; border: 1px dashed #cfcfcf; background: transparent; color: #666;
  border-radius: 6px; padding: 9px; font-size: 13px; cursor: pointer; transition: all .15s;
}
.new-room-btn:hover { border-color: var(--green); color: var(--green); background: #f2fbf5; }

/* ---------- 顶栏 ---------- */
.chat-header {
  height: 58px; flex-shrink: 0; display: flex; align-items: center; gap: 10px;
  padding: 0 18px 0 12px; background: var(--bg); border-bottom: 1px solid var(--line);
}
.chat-title { flex: 1 1 auto; min-width: 0; line-height: 1.25; }
.chat-name { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-sub { font-size: 11px; color: var(--muted); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-actions { display: flex; align-items: center; gap: 4px; }

/* ---------- 消息区 ---------- */
.message-scroll { flex: 1 1 auto; overflow-y: auto; padding: 16px 22px 6px; display: flex; flex-direction: column; }
.messages-inner { flex: 0 0 auto; margin-top: auto; }
.day-sep { text-align: center; margin: 16px 0 18px; }
.day-sep span { font-size: 11px; color: #fff; background: #dadada; padding: 2px 8px; border-radius: 4px; }
.msg { display: flex; gap: 10px; margin-bottom: 16px; align-items: flex-start; }
.msg.mine { flex-direction: row-reverse; }
.msg-body { max-width: min(560px, 68%); display: flex; flex-direction: column; align-items: flex-start; }
.msg.mine .msg-body { align-items: flex-end; }
.msg-name { font-size: 11px; color: var(--muted); margin: 0 0 4px 2px; }
.msg-line { display: flex; align-items: center; gap: 6px; }
.msg.mine .msg-line { flex-direction: row-reverse; }
.bubble {
  position: relative; background: #fff; border-radius: 5px; padding: 9px 12px;
  font-size: 15px; line-height: 1.6; word-break: break-word; white-space: normal;
  box-shadow: 0 1px 1px rgba(0,0,0,.05);
}
.msg.mine .bubble { background: var(--bubble); }
.bubble::after {
  content: ''; position: absolute; top: 12px; left: -5px; width: 0; height: 0;
  border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-right: 5px solid #fff;
}
.msg.mine .bubble::after { left: auto; right: -5px; border-right: 0; border-left: 5px solid var(--bubble); }
.bubble p { margin: 0 0 6px; }
.bubble p:last-child { margin-bottom: 0; }
.bubble .collapsed { max-height: 96px; overflow: hidden; position: relative; cursor: pointer; }
.bubble.retracted { color: #a8a8a8; font-style: italic; background: #f0f0f0; }
.msg.mine .bubble.retracted { background: #f0f0f0; }
.msg.mine .bubble.retracted::after { border-left-color: #f0f0f0; }
.msg.theirs .bubble.retracted::after { border-right-color: #f0f0f0; }
.msg-tools {
  opacity: 0; transition: opacity .15s; font-size: 11px; color: var(--muted);
  cursor: pointer; padding: 2px 6px; border-radius: 4px; white-space: nowrap; user-select: none;
}
.msg:hover .msg-tools { opacity: 1; }
.msg-tools:hover { background: rgba(0,0,0,.06); color: #555; }
.sys-msg { text-align: center; margin: 10px 0; }
.sys-msg span {
  font-size: 11px; color: #8c8c8c; background: rgba(0,0,0,.045);
  padding: 3px 8px; border-radius: 4px; display: inline-block; max-width: 80%;
}
.sys-msg.error span { color: #c94b4b; background: rgba(250,81,81,.09); }
.typing-line { height: 0; overflow: hidden; font-size: 11px; color: var(--muted); padding: 0 24px; transition: height .15s; }
.typing-line.on { height: 20px; padding-top: 4px; }

/* ---------- 输入区 ---------- */
.composer {
  flex-shrink: 0; border-top: 1px solid var(--line); background: var(--bg);
  padding: 10px 18px 14px; display: flex; align-items: flex-end; gap: 8px; position: relative;
}
.composer-tools { display: flex; align-items: center; gap: 2px; padding-bottom: 4px; }
#message-input {
  flex: 1 1 auto; border: none; outline: none; resize: none; background: #fff;
  border-radius: 6px; padding: 10px 12px; font-size: 15px; line-height: 1.5;
  max-height: 132px; min-height: 40px; font-family: inherit; color: var(--text);
  box-shadow: 0 1px 1px rgba(0,0,0,.04);
}
#message-input::placeholder { color: #b3b3b3; }
.send-btn {
  border: none; background: var(--green); color: #fff; border-radius: 6px;
  padding: 0 18px; height: 40px; font-size: 14px; cursor: pointer; transition: background .15s; flex-shrink: 0;
}
.send-btn:hover { background: var(--green-dark); }
.send-btn:disabled { background: #c9c9c9; cursor: default; }
.emoji-picker {
  position: absolute; bottom: 68px; left: 18px; background: #fff; border: 1px solid var(--line);
  border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.12); padding: 8px; display: none;
  grid-template-columns: repeat(8, 32px); gap: 4px; z-index: 40;
}
.emoji-picker.visible { display: grid; }
.emoji-picker span { cursor: pointer; font-size: 19px; text-align: center; line-height: 32px; border-radius: 4px; }
.emoji-picker span:hover { background: #f0f0f0; }

/* ---------- 头像 ---------- */
.av { border-radius: 5px; overflow: hidden; flex-shrink: 0; display: flex; align-items: center; justify-content: center; user-select: none; font-weight: 600; }
.av img { width: 100%; height: 100%; object-fit: cover; }
.av-40 { width: 40px; height: 40px; font-size: 16px; }
.av-44 { width: 44px; height: 44px; font-size: 17px; }
.av-42 { width: 42px; height: 42px; font-size: 17px; }
.av-64 { width: 64px; height: 64px; font-size: 24px; border-radius: 8px; }
.av-emoji { background: #e4e4e4; }
.av-letter { color: #fff; }

/* ---------- 登录层 ---------- */
.auth-layer {
  position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(1100px 560px at 18% 8%, #e6f7ec 0%, #f1f7f2 42%, #edf0ed 100%);
  padding: 20px;
}
.auth-card {
  width: 372px; max-width: 100%; background: #fff; border-radius: 14px;
  box-shadow: 0 20px 56px rgba(31,60,42,.13); padding: 30px 30px 24px;
  animation: pop .3s cubic-bezier(.2,.9,.3,1.1);
}
@keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
.auth-brand { text-align: center; margin-bottom: 22px; }
.auth-logo {
  width: 54px; height: 54px; margin: 0 auto 12px; border-radius: 14px;
  background: linear-gradient(145deg, #28d97f, #07c160); color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 700;
  box-shadow: 0 8px 18px rgba(7,193,96,.28);
}
.auth-title { font-size: 19px; font-weight: 600; letter-spacing: .5px; }
.auth-sub { font-size: 12px; color: var(--muted); margin-top: 6px; }
.auth-tabs { display: flex; background: #f2f2f2; border-radius: 8px; padding: 3px; margin-bottom: 18px; }
.auth-tab {
  flex: 1 1 0; border: none; background: transparent; padding: 8px 0; border-radius: 6px;
  font-size: 13px; color: #666; cursor: pointer; transition: all .18s;
}
.auth-tab.active { background: #fff; color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.auth-label { display: block; font-size: 12px; color: #7a7a7a; margin: 14px 0 6px; }
.auth-input {
  width: 100%; border: 1px solid #e2e2e2; border-radius: 8px; padding: 11px 12px;
  font-size: 14px; outline: none; transition: border-color .15s, box-shadow .15s; color: var(--text);
}
.auth-input:focus { border-color: var(--green); box-shadow: 0 0 0 3px rgba(7,193,96,.1); }
.auth-btn {
  width: 100%; border: none; background: var(--green); color: #fff; border-radius: 8px;
  padding: 12px; font-size: 15px; cursor: pointer; margin-top: 20px; transition: background .15s;
}
.auth-btn:hover { background: var(--green-dark); }
.auth-btn:disabled { background: #bfbfbf; cursor: default; }
.auth-error { font-size: 12px; color: var(--danger); min-height: 16px; margin-top: 10px; }
.auth-hint { font-size: 11px; color: #a8a8a8; text-align: center; margin-top: 14px; line-height: 1.7; }
.avatar-row { display: flex; align-items: center; gap: 14px; margin-top: 4px; }
.avatar-upload {
  border: 1px solid #e2e2e2; background: #fff; border-radius: 7px; padding: 7px 12px;
  font-size: 12px; color: #555; cursor: pointer; transition: all .15s;
}
.avatar-upload:hover { border-color: var(--green); color: var(--green); }
.avatar-tip { font-size: 11px; color: #a8a8a8; line-height: 1.6; }
.emoji-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.emoji-row .av { width: 34px; height: 34px; font-size: 17px; cursor: pointer; border: 2px solid transparent; background: #f2f2f2; }
.emoji-row .av.sel { border-color: var(--green); background: #eafaf0; }

/* ---------- 设置抽屉 ---------- */
.drawer-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.26); z-index: 80;
  opacity: 0; pointer-events: none; transition: opacity .25s;
}
.drawer-mask.open { opacity: 1; pointer-events: auto; }
.drawer {
  position: fixed; top: 0; right: 0; height: 100%; width: 344px; max-width: 88vw; background: #fff;
  box-shadow: -10px 0 34px rgba(0,0,0,.12); z-index: 90; display: flex; flex-direction: column;
  transform: translateX(102%); transition: transform .28s cubic-bezier(.4,0,.2,1);
}
.drawer.open { transform: none; }
.drawer-head {
  display: flex; align-items: center; justify-content: space-between; padding: 16px 18px;
  border-bottom: 1px solid var(--line); font-size: 15px; font-weight: 600; flex-shrink: 0;
}
.drawer-body { padding: 16px 18px 26px; overflow-y: auto; }
.field-label { font-size: 12px; color: #7a7a7a; margin: 18px 0 8px; }
.field-label:first-child { margin-top: 0; }
.text-input {
  width: 100%; border: 1px solid #e2e2e2; border-radius: 7px; padding: 9px 11px;
  font-size: 14px; outline: none; color: var(--text);
}
.text-input:focus { border-color: var(--green); }
.primary-btn {
  width: 100%; border: none; background: var(--green); color: #fff; border-radius: 7px;
  padding: 11px; font-size: 14px; cursor: pointer; margin-top: 24px;
}
.primary-btn:hover { background: var(--green-dark); }
.ghost-btn {
  border: 1px solid #e2e2e2; background: #fff; border-radius: 7px; padding: 9px 12px;
  font-size: 13px; color: #555; cursor: pointer; transition: all .15s;
}
.ghost-btn:hover { border-color: #c9c9c9; background: #fafafa; }
.ghost-btn.block { display: block; width: 100%; margin-top: 12px; }
.danger-btn {
  display: block; width: 100%; border: 1px solid #f5c6c6; background: #fff; color: var(--danger);
  border-radius: 7px; padding: 10px; font-size: 13px; cursor: pointer; margin-top: 10px;
}
.danger-btn:hover { background: #fff5f5; }
.switch-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: #444; }
.switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; cursor: pointer; inset: 0; background: #d6d6d6; transition: .3s; border-radius: 24px;
}
.slider:before {
  position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px;
  background: #fff; transition: .3s; border-radius: 50%;
}
input:checked + .slider { background: var(--green); }
input:checked + .slider:before { transform: translateX(20px); }
.tip { font-size: 11px; color: #aaa; line-height: 1.7; margin-top: 20px; }

/* ---------- 新建会话弹窗 ---------- */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 110;
  display: none; align-items: center; justify-content: center; padding: 20px;
}
.modal-mask.open { display: flex; }
.modal {
  width: 340px; max-width: 100%; background: #fff; border-radius: 12px; padding: 22px;
  box-shadow: 0 18px 50px rgba(0,0,0,.18); animation: pop .24s ease-out;
}
.modal h4 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.modal p { margin: 0 0 14px; font-size: 12px; color: var(--muted); }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
.modal-actions .ghost-btn, .modal-actions .primary-btn { width: auto; margin: 0; padding: 8px 18px; }

/* ---------- 移动端 ---------- */
.sidebar-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 29;
  opacity: 0; pointer-events: none; transition: opacity .25s;
}
@media (max-width: 820px) {
  .sidebar { position: fixed; left: 0; top: 0; bottom: 0; margin-left: 0 !important; transform: translateX(-102%); }
  .app.mobile-open .sidebar { transform: none; }
  .app.mobile-open .sidebar-mask { opacity: 1; pointer-events: auto; }
  .message-scroll { padding: 14px 14px 4px; }
  .msg-body { max-width: 76%; }
  .composer { padding: 8px 12px 12px; }
  .chat-header { padding: 0 12px 0 8px; }
  .bubble { font-size: 14.5px; }
}
</style>
</head>
<body>

<div class="app" id="app" style="display:none">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-top">
      <div class="me-card" id="me-card">
        <div id="me-avatar"></div>
        <div class="me-info">
          <div class="me-name" id="me-name">未登录</div>
          <div class="me-id" id="me-id">点击修改资料</div>
        </div>
      </div>
      <button class="icon-btn" id="btn-settings" title="设置">&#9881;</button>
    </div>
    <div class="search-box">
      <input id="search-input" placeholder="搜索会话" autocomplete="off">
    </div>
    <div class="conv-scroll" id="conv-list"></div>
    <div class="sidebar-foot">
      <button class="new-room-btn" id="btn-new-room">＋ 新建群聊</button>
    </div>
  </aside>
  <div class="sidebar-mask" id="sidebar-mask"></div>

  <main class="chat">
    <header class="chat-header">
      <button class="icon-btn" id="btn-toggle-sidebar" title="收起 / 展开侧栏">&#9776;</button>
      <div class="chat-title">
        <div class="chat-name" id="chat-name">大厅</div>
        <div class="chat-sub" id="chat-sub">正在连接...</div>
      </div>
      <div class="chat-actions">
        <button class="icon-btn" id="btn-settings-2" title="设置">&#8942;</button>
      </div>
    </header>
    <div class="message-scroll" id="messages"><div class="messages-inner" id="messages-inner"></div></div>
    <div class="typing-line" id="typing-indicator"></div>
    <div class="composer">
      <div class="composer-tools">
        <button class="icon-btn" id="emoji-toggle" title="表情">&#128522;</button>
      </div>
      <textarea id="message-input" rows="1" placeholder="请输入消息，Enter 发送，Shift + Enter 换行" autocomplete="off"></textarea>
      <button class="send-btn" id="send-button">发送</button>
      <div class="emoji-picker" id="emoji-picker"></div>
    </div>
  </main>
</div>

<!-- 登录 / 注册 -->
<div class="auth-layer" id="auth-layer">
  <div class="auth-card">
    <div class="auth-brand">
      <div class="auth-logo">Z</div>
      <div class="auth-title">ZChat</div>
      <div class="auth-sub">轻量、私密的多人聊天室</div>
    </div>
    <div class="auth-tabs">
      <button class="auth-tab active" data-mode="login">登录</button>
      <button class="auth-tab" data-mode="register">注册</button>
    </div>

    <div id="reg-avatar-block" style="display:none">
      <label class="auth-label">头像</label>
      <div class="avatar-row">
        <div id="reg-avatar-preview"></div>
        <div>
          <button class="avatar-upload" id="reg-upload-btn" type="button">导入图片</button>
          <input type="file" id="reg-avatar-file" accept="image/*" style="display:none">
          <div class="avatar-tip">支持 JPG / PNG / GIF / WebP<br>也可从下方挑一个表情</div>
        </div>
      </div>
      <div class="emoji-row" id="reg-emoji-row"></div>
    </div>

    <label class="auth-label">昵称</label>
    <input class="auth-input" id="auth-name" maxlength="16" placeholder="给自己起个名字" autocomplete="username">
    <label class="auth-label">密码</label>
    <input class="auth-input" id="auth-pass" type="password" maxlength="32" placeholder="至少 4 位" autocomplete="current-password">
    <div class="auth-error" id="auth-error"></div>
    <button class="auth-btn" id="auth-submit">登录</button>
    <div class="auth-hint" id="auth-hint">账号与头像只保存在本机浏览器，不会上传到服务器。</div>
  </div>
</div>

<!-- 设置抽屉 -->
<div class="drawer-mask" id="drawer-mask"></div>
<div class="drawer" id="settings-drawer">
  <div class="drawer-head">
    <span>个人设置</span>
    <button class="icon-btn" id="drawer-close">&#10005;</button>
  </div>
  <div class="drawer-body">
    <div class="field-label">头像</div>
    <div class="avatar-row">
      <div id="set-avatar-preview"></div>
      <div>
        <button class="ghost-btn" id="set-upload-btn" type="button">导入图片</button>
        <input type="file" id="set-avatar-file" accept="image/*" style="display:none">
        <div class="avatar-tip">图片会自动裁成方形并压缩</div>
      </div>
    </div>
    <div class="emoji-row" id="set-emoji-row"></div>

    <div class="field-label">昵称</div>
    <input class="text-input" id="set-name" maxlength="16" placeholder="昵称">

    <div class="field-label">显示</div>
    <div class="switch-row">
      <span>渲染富文本（Markdown / HTML）</span>
      <label class="switch"><input type="checkbox" id="render-html-toggle"><span class="slider"></span></label>
    </div>

    <div class="field-label">加载历史条数</div>
    <input class="text-input" id="history-limit-input" type="number" min="1" max="100" value="50">

    <button class="primary-btn" id="save-settings">保存</button>
    <button class="danger-btn" id="clear-messages">清空当前聊天记录</button>
    <button class="ghost-btn block" id="reset-rooms">重置群组列表</button>
    <button class="ghost-btn block" id="btn-logout">退出登录</button>
    <p class="tip">账号、头像和群组列表保存在本机浏览器；聊天消息保存在云端，每个会话最多保留最近 100 条。清空聊天记录会对所有人生效。</p>
  </div>
</div>

<!-- 新建会话 -->
<div class="modal-mask" id="new-room-modal">
  <div class="modal">
    <h4>新建群聊</h4>
    <p>创建一个新的会话房间，其他人可以通过同一浏览器列表进入。</p>
    <input class="text-input" id="new-room-name" maxlength="12" placeholder="群聊名称，例如：周末聚会">
    <div class="modal-actions">
      <button class="ghost-btn" id="new-room-cancel">取消</button>
      <button class="primary-btn" id="new-room-ok">创建</button>
    </div>
  </div>
</div>

<script>
(function () {
  'use strict';

  var LS = {
    accounts: 'zchat_accounts',
    session: 'zchat_session',
    rooms: 'zchat_rooms',
    active: 'zchat_active_room',
    settings: 'zchat_client_settings',
    collapsed: 'zchat_sidebar_collapsed',
    seen: 'zchat_seen'
  };

  var DEFAULT_ROOMS = [
    { id: 'hall', name: '大厅', group: '公共频道', emoji: '🏛' },
    { id: 'tech', name: '技术交流', group: '公共频道', emoji: '🛠' },
    { id: 'random', name: '随便聊聊', group: '公共频道', emoji: '🎈' },
    { id: 'class9', name: '9班内部群', group: '我的群组', emoji: '🎓' }
  ];

  var EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥', '💯', '🤔', '😊', '🥳', '🤯', '🤣', '🙌', '✨'];
  var AVATAR_EMOJIS = ['😀', '😎', '🤖', '👻', '👽', '🐼', '🦊', '🐳', '🌸', '🍀', '🎧', '🐱'];

  var el = function (id) { return document.getElementById(id); };

  var state = {
    account: null,
    myId: '',
    rooms: [],
    activeId: '',
    avatars: {},
    messages: {},
    conns: {},
    typingUsers: new Map(),
    typingTimer: null,
    renderHtml: false,
    historyLimit: 50,
    regAvatar: '',
    setAvatar: '',
    lastRenderedTs: 0
  };

  // ---------------- 工具 ----------------
  function escapeHtml(value) {
    if (typeof value !== 'string') value = String(value == null ? '' : value);
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function firstChar(name) {
    var text = String(name || '?').trim();
    if (!text) return '?';
    var ch = text.charAt(0);
    if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
    return ch;
  }

  function colorFor(name) {
    var palette = ['#5b8ff9', '#61ddaa', '#f6bd16', '#7262fd', '#78d3f8', '#9661bc', '#f6903d', '#e8684a', '#6dc8ec', '#9270ca'];
    var text = String(name || '');
    var hash = 0;
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 100000;
    return palette[hash % palette.length];
  }

  function safeAvatar(value) {
    if (typeof value !== 'string') return '';
    if (value.indexOf('data:image/') === 0) {
      var lower = value.toLowerCase();
      var ok = lower.indexOf('data:image/png;base64,') === 0 ||
        lower.indexOf('data:image/jpeg;base64,') === 0 ||
        lower.indexOf('data:image/jpg;base64,') === 0 ||
        lower.indexOf('data:image/gif;base64,') === 0 ||
        lower.indexOf('data:image/webp;base64,') === 0;
      return ok ? value : '';
    }
    if (value.indexOf('https://') === 0 || value.indexOf('http://') === 0) return value;
    return value.slice(0, 8);
  }

  function buildAvatar(avatar, name, sizeClass) {
    var box = document.createElement('div');
    box.className = 'av ' + (sizeClass || 'av-40');
    var safe = safeAvatar(avatar || '');
    if (safe.indexOf('data:image/') === 0 || safe.indexOf('http') === 0) {
      var img = document.createElement('img');
      img.src = safe;
      img.alt = '';
      box.appendChild(img);
    } else if (safe) {
      box.classList.add('av-emoji');
      box.textContent = safe;
    } else {
      box.classList.add('av-letter');
      box.style.background = colorFor(name);
      box.textContent = firstChar(name);
    }
    return box;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function listTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var yesterday = new Date(now.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function dayText(ts) {
    var d = new Date(ts);
    var now = new Date();
    var clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return clock;
    var yesterday = new Date(now.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + clock;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + clock;
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function sha256(text) {
    if (!window.crypto || !window.crypto.subtle) {
      return Promise.resolve('plain:' + text);
    }
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      var arr = Array.prototype.slice.call(new Uint8Array(buf));
      return arr.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  // 图片压缩成方形头像
  function fileToAvatar(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) {
        reject(new Error('请选择图片文件'));
        return;
      }
      if (file.size > 12 * 1024 * 1024) {
        reject(new Error('图片太大，请选择 12MB 以内的图片'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          try {
            var size = 72;
            var canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);
            var scale = Math.max(size / img.width, size / img.height);
            var w = img.width * scale;
            var h = img.height * scale;
            ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.72));
          } catch (err) {
            reject(new Error('图片处理失败'));
          }
        };
        img.onerror = function () { reject(new Error('图片解析失败')); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsDataURL(file);
    });
  }

  // ---------------- 登录 / 注册 ----------------
  var authMode = 'login';

  function accounts() {
    var list = readJSON(LS.accounts, []);
    return Array.isArray(list) ? list : [];
  }

  function saveAccounts(list) { writeJSON(LS.accounts, list); }

  function setAuthMode(mode) {
    authMode = mode;
    var tabs = document.querySelectorAll('.auth-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mode') === mode);
    }
    el('reg-avatar-block').style.display = mode === 'register' ? 'block' : 'none';
    el('auth-submit').textContent = mode === 'register' ? '注册并进入' : '登录';
    el('auth-pass').placeholder = mode === 'register' ? '设置密码（至少 4 位）' : '请输入密码';
    el('auth-hint').textContent = mode === 'register'
      ? '账号与头像只保存在本机浏览器，注册后即可进入聊天室。'
      : '首次使用请先切换到「注册」创建账号。';
    el('auth-error').textContent = '';
  }

  function renderRegAvatar() {
    var preview = el('reg-avatar-preview');
    preview.innerHTML = '';
    var avatar = buildAvatar(state.regAvatar, el('auth-name').value || 'Z', 'av-64');
    preview.appendChild(avatar);
  }

  function renderRegEmojiRow() {
    var row = el('reg-emoji-row');
    row.innerHTML = '';
    AVATAR_EMOJIS.forEach(function (emoji) {
      var item = document.createElement('div');
      item.className = 'av av-emoji' + (state.regAvatar === emoji ? ' sel' : '');
      item.textContent = emoji;
      item.addEventListener('click', function () {
        state.regAvatar = emoji;
        renderRegEmojiRow();
        renderRegAvatar();
      });
      row.appendChild(item);
    });
  }

  function showAuthError(text) {
    el('auth-error').textContent = text || '';
  }

  function submitAuth() {
    var name = (el('auth-name').value || '').trim();
    var pass = el('auth-pass').value || '';
    showAuthError('');

    if (!name) { showAuthError('请输入昵称'); return; }
    if (name.length < 2) { showAuthError('昵称至少 2 个字符'); return; }
    if (pass.length < 4) { showAuthError('密码至少 4 位'); return; }

    var btn = el('auth-submit');
    btn.disabled = true;

    if (authMode === 'register') {
      var list = accounts();
      var exists = list.some(function (acc) { return acc.name === name; });
      if (exists) {
        btn.disabled = false;
        showAuthError('该昵称已注册，请直接登录或换个昵称');
        return;
      }
      var salt = Math.random().toString(36).slice(2, 10);
      sha256(salt + ':' + pass).then(function (hash) {
        var account = {
          id: (crypto.randomUUID ? crypto.randomUUID() : 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
          name: name,
          salt: salt,
          hash: hash,
          avatar: state.regAvatar || '',
          createdAt: Date.now()
        };
        var next = accounts();
        next.push(account);
        saveAccounts(next);
        btn.disabled = false;
        enterApp(account);
      });
      return;
    }

    var found = null;
    var all = accounts();
    for (var i = 0; i < all.length; i++) {
      if (all[i].name === name) { found = all[i]; break; }
    }
    if (!found) {
      btn.disabled = false;
      showAuthError('该昵称尚未注册，请先注册');
      return;
    }
    sha256(found.salt + ':' + pass).then(function (hash) {
      btn.disabled = false;
      if (hash !== found.hash) { showAuthError('密码不正确'); return; }
      enterApp(found);
    });
  }

  function enterApp(account) {
    state.account = account;
    state.myId = account.id;
    state.regAvatar = account.avatar || '';
    writeJSON(LS.session, { name: account.name, at: Date.now() });

    el('auth-layer').style.display = 'none';
    el('app').style.display = 'flex';

    el('me-name').textContent = account.name;
    el('me-id').textContent = 'ID ' + account.id.slice(0, 8);

    var meAvatarBox = el('me-avatar');
    meAvatarBox.innerHTML = '';
    meAvatarBox.appendChild(buildAvatar(account.avatar, account.name, 'av-44'));

    loadRooms();
    loadSettings();
    bindAppEvents();
    updatePlaceholder();
    renderConvs();
    setActiveRoom(localStorage.getItem(LS.active) || state.rooms[0].id || 'hall');
  }

  // ---------------- 会话列表 ----------------
  function loadRooms() {
    var saved = readJSON(LS.rooms, null);
    if (Array.isArray(saved) && saved.length) {
      state.rooms = saved;
    } else {
      state.rooms = DEFAULT_ROOMS.slice();
      writeJSON(LS.rooms, state.rooms);
    }
    var seen = readJSON(LS.seen, {});
    state.rooms.forEach(function (room) {
      room.unread = 0;
      room.online = 0;
      room.last = null;
      // 没有已读记录时以当前时间为基线，历史消息不计未读
      room.seenTs = (seen && seen[room.id]) || Date.now();
    });
  }

  function roomById(id) {
    for (var i = 0; i < state.rooms.length; i++) {
      if (state.rooms[i].id === id) return state.rooms[i];
    }
    return null;
  }

  function renderConvs() {
    var keyword = (el('search-input').value || '').trim().toLowerCase();
    var wrap = el('conv-list');
    wrap.innerHTML = '';

    var groups = [];
    state.rooms.forEach(function (room) {
      if (keyword && room.name.toLowerCase().indexOf(keyword) === -1) return;
      var groupName = room.group || '我的群组';
      var bucket = null;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].name === groupName) { bucket = groups[i]; break; }
      }
      if (!bucket) { bucket = { name: groupName, items: [] }; groups.push(bucket); }
      bucket.items.push(room);
    });

    if (!groups.length) {
      var empty = document.createElement('div');
      empty.className = 'conv-group';
      empty.textContent = '没有匹配的会话';
      wrap.appendChild(empty);
      return;
    }

    groups.forEach(function (group) {
      var title = document.createElement('div');
      title.className = 'conv-group';
      title.innerHTML = '<span>' + escapeHtml(group.name) + '</span><span>' + group.items.length + '</span>';
      wrap.appendChild(title);

      group.items.forEach(function (room) {
        var item = document.createElement('div');
        item.className = 'conv-item' + (room.id === state.activeId ? ' active' : '');
        item.setAttribute('data-room', room.id);

        var avatarBox = room.avatarUrl
          ? buildAvatar(room.avatarUrl, room.name, 'av-42')
          : buildAvatar(room.emoji || '', room.name, 'av-42');
        if (!room.avatarUrl && !room.emoji) {
          avatarBox.classList.remove('av-emoji');
          avatarBox.classList.add('av-letter');
          avatarBox.style.background = colorFor(room.name);
          avatarBox.textContent = firstChar(room.name);
        }
        item.appendChild(avatarBox);

        var main = document.createElement('div');
        main.className = 'conv-main';

        var row1 = document.createElement('div');
        row1.className = 'conv-row';
        var nameEl = document.createElement('div');
        nameEl.className = 'conv-name';
        nameEl.textContent = room.name;
        var timeEl = document.createElement('div');
        timeEl.className = 'conv-time';
        timeEl.textContent = room.last ? listTime(room.last.timestamp) : '';
        row1.appendChild(nameEl);
        row1.appendChild(timeEl);

        var row2 = document.createElement('div');
        row2.className = 'conv-row';
        row2.style.marginTop = '4px';
        var snippet = document.createElement('div');
        snippet.className = 'conv-snippet';
        if (room.last) {
          var text = room.last.isRetracted ? '此消息已被撤回' : String(room.last.text || '');
          snippet.textContent = (room.last.name ? room.last.name + ': ' : '') + text;
        } else {
          snippet.textContent = '暂无消息';
        }
        row2.appendChild(snippet);
        if (room.unread > 0) {
          var badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = room.unread > 99 ? '99+' : String(room.unread);
          row2.appendChild(badge);
        }

        main.appendChild(row1);
        main.appendChild(row2);
        item.appendChild(main);

        item.addEventListener('click', function () {
          setActiveRoom(room.id);
          closeMobileSidebar();
        });

        wrap.appendChild(item);
      });
    });
  }

  // ---------------- 连接管理 ----------------
  function wsUrl(roomId, mode) {
    var protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return protocol + '://' + window.location.host + '/ws?room=' + encodeURIComponent(roomId) + (mode === 'preview' ? '&preview=1' : '');
  }

  function closeConn(roomId) {
    var conn = state.conns[roomId];
    if (!conn) return;
    conn.manual = true;
    if (conn.timer) clearTimeout(conn.timer);
    try { if (conn.ws) conn.ws.close(); } catch (e) {}
    delete state.conns[roomId];
  }

  function connect(roomId, mode) {
    var existing = state.conns[roomId];
    if (existing && existing.mode === mode && existing.ws &&
      (existing.ws.readyState === 0 || existing.ws.readyState === 1)) {
      return;
    }
    closeConn(roomId);

    var ws;
    try { ws = new WebSocket(wsUrl(roomId, mode)); } catch (e) { return; }

    var conn = { ws: ws, mode: mode, manual: false, retry: 0, timer: null };
    state.conns[roomId] = conn;

    ws.onopen = function () {
      conn.retry = 0;
      if (mode === 'full') sendIdentity(roomId);
    };

    ws.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      handleIncoming(roomId, mode, data);
    };

    ws.onclose = function () {
      if (conn.manual) return;
      if (state.conns[roomId] !== conn) return;
      conn.retry = Math.min(conn.retry + 1, 6);
      var delay = Math.min(15000, Math.pow(2, conn.retry) * 500) + Math.random() * 400;
      conn.timer = setTimeout(function () {
        if (state.conns[roomId] === conn) connect(roomId, mode);
      }, delay);
    };

    ws.onerror = function () {};
  }

  function sendIdentity(roomId) {
    var conn = state.conns[roomId];
    if (!conn || !conn.ws || conn.ws.readyState !== 1) return;
    var account = state.account;
    if (!account) return;
    conn.ws.send(JSON.stringify({
      type: 'identity',
      id: account.id,
      name: account.name,
      avatar: account.avatar || ''
    }));
  }

  function handleIncoming(roomId, mode, data) {
    var room = roomById(roomId);
    if (!room) return;
    var isActive = roomId === state.activeId;

    if (mode === 'preview') {
      if (data.type === 'preview' && data.info) {
        room.online = data.info.online || 0;
        var newer = data.info.last ? applyLast(room, data.info.last, isActive) : false;
        if (newer && !isActive && room.previewed && data.info.last.timestamp > (room.seenTs || 0)) {
          room.unread = (room.unread || 0) + 1;
        }
        room.previewed = true;
        renderConvs();
      } else if (data.type === 'preview-cleared') {
        room.last = null;
        room.unread = 0;
        renderConvs();
      } else if (data.type === 'preview-update' && data.message) {
        if (applyLast(room, data.message, isActive) && !isActive && data.message.timestamp > (room.seenTs || 0)) {
          room.unread = (room.unread || 0) + 1;
        }
        renderConvs();
      }
      return;
    }

    switch (data.type) {
      case 'history':
        state.messages[roomId] = Array.isArray(data.messages) ? data.messages : [];
        if (data.avatars) {
          Object.keys(data.avatars).forEach(function (uid) {
            state.avatars[uid] = data.avatars[uid];
          });
        }
        if (state.messages[roomId].length) {
          var lastMsg = state.messages[roomId][state.messages[roomId].length - 1];
          applyLast(room, lastMsg, true);
        }
        room.online = data.online || 0;
        if (isActive) renderMessages();
        renderConvs();
        updateHeader();
        break;

      case 'message':
        if (!state.messages[roomId]) state.messages[roomId] = [];
        state.messages[roomId].push(data);
        if (data.avatar !== undefined && data.id) {
          state.avatars[data.id] = { name: data.name, avatar: data.avatar };
        }
        applyLast(room, data, isActive);
        if (isActive) {
          appendMessage(data);
          scrollToBottom(true);
          markSeen(room);
        } else if (data.timestamp > (room.seenTs || 0)) {
          room.unread = (room.unread || 0) + 1;
        }
        renderConvs();
        break;

      case 'peer':
        if (data.user && data.user.id) {
          state.avatars[data.user.id] = { name: data.user.name, avatar: data.user.avatar };
          refreshAvatarInPlace(data.user.id, data.user.avatar, data.user.name);
        }
        break;

      case 'identity':
        if (data.id) {
          state.myId = data.id;
          if (!state.account.avatar && data.avatar) state.account.avatar = data.avatar;
        }
        break;

      case 'status':
        room.online = data.online || 0;
        room.remaining = data.remaining;
        renderConvs();
        updateHeader();
        break;

      case 'info':
        if (isActive) addSystemMessage(data.message, 'info');
        break;

      case 'error':
        if (isActive) addSystemMessage(data.message, 'error');
        break;

      case 'typing':
        if (isActive && data.id !== state.myId) showTyping(data.name);
        break;

      case 'retract':
        applyRetract(data.messageId);
        break;

      case 'cleared':
        state.messages[roomId] = [];
        room.last = null;
        room.unread = 0;
        if (isActive) {
          state.lastRenderedTs = 0;
          renderMessages();
        }
        renderConvs();
        break;
    }
  }

  function applyLast(room, message, isActive) {
    var prevTs = room.last ? room.last.timestamp : 0;
    var isNew = message.timestamp > prevTs;
    if (isNew) room.last = message;
    if (isActive) {
      room.unread = 0;
      room.seenTs = message.timestamp;
    }
    return isNew;
  }

  function markSeen(room) {
    room.unread = 0;
    room.seenTs = Date.now();
    var seen = readJSON(LS.seen, {});
    seen[room.id] = room.seenTs;
    writeJSON(LS.seen, seen);
  }

  // ---------------- 房间切换 ----------------
  function setActiveRoom(roomId) {
    var room = roomById(roomId);
    if (!room) return;

    if (state.activeId && state.activeId !== roomId) {
      var oldRoom = roomById(state.activeId);
      if (oldRoom) markSeen(oldRoom);
    }

    state.activeId = roomId;
    localStorage.setItem(LS.active, roomId);

    // 除当前房间外，其余房间只用轻量预览连接
    Object.keys(state.conns).forEach(function (rid) {
      var conn = state.conns[rid];
      if (rid !== roomId && conn.mode === 'full') {
        closeConn(rid);
        connect(rid, 'preview');
      }
      if (rid === roomId && conn.mode === 'preview') {
        closeConn(rid);
      }
    });

    connect(roomId, 'full');
    room.unread = 0;
    updateHeader();
    renderConvs();
    renderMessages();

    var previewCount = Object.keys(state.conns).filter(function (rid) {
      return state.conns[rid].mode === 'preview';
    }).length;
    state.rooms.forEach(function (item) {
      if (item.id === roomId || state.conns[item.id]) return;
      if (previewCount >= 6) return;
      previewCount++;
      connect(item.id, 'preview');
    });
  }

  function updateHeader() {
    var room = roomById(state.activeId);
    if (!room) return;
    el('chat-name').textContent = room.name;
    var parts = [];
    if (room.online) parts.push(room.online + ' 人在线');
    if (typeof room.remaining === 'number') parts.push('今日剩余 ' + room.remaining.toLocaleString());
    if (!parts.length) parts.push('正在连接...');
    el('chat-sub').textContent = parts.join(' · ');
  }

  // ---------------- 消息渲染 ----------------
  function renderMessages() {
    var wrap = el('messages-inner');
    wrap.innerHTML = '';
    state.lastRenderedTs = 0;
    var list = state.messages[state.activeId] || [];
    var limit = state.historyLimit > 0 ? state.historyLimit : list.length;
    var visible = list.slice(-limit);

    if (!visible.length) {
      var hint = document.createElement('div');
      hint.className = 'sys-msg empty-hint';
      hint.innerHTML = '<span>还没有消息，来说第一句话吧</span>';
      wrap.appendChild(hint);
      return;
    }

    visible.forEach(function (msg) { appendMessage(msg); });
    scrollToBottom(false);
  }

  function appendMessage(msg) {
    var wrap = el('messages-inner');
    var placeholder = wrap.querySelector('.empty-hint');
    if (placeholder) placeholder.remove();
    if (!state.lastRenderedTs || msg.timestamp - state.lastRenderedTs > 5 * 60 * 1000) {
      var sep = document.createElement('div');
      sep.className = 'day-sep';
      var span = document.createElement('span');
      span.textContent = dayText(msg.timestamp);
      sep.appendChild(span);
      wrap.appendChild(sep);
    }
    state.lastRenderedTs = msg.timestamp;

    var mine = msg.id === state.myId;
    var item = document.createElement('div');
    item.className = 'msg ' + (mine ? 'mine' : 'theirs');
    item.setAttribute('data-message-id', msg.messageId || '');

    var peer = state.avatars[msg.id] || { name: msg.name, avatar: msg.avatar || '' };
    var avatarBox = buildAvatar(peer.avatar, msg.name, 'av-40');
    avatarBox.classList.add('msg-avatar');
    avatarBox.setAttribute('data-uid', msg.id || '');
    item.appendChild(avatarBox);

    var body = document.createElement('div');
    body.className = 'msg-body';

    if (!mine) {
      var nameEl = document.createElement('div');
      nameEl.className = 'msg-name';
      nameEl.textContent = msg.name || '匿名';
      body.appendChild(nameEl);
    }

    var line = document.createElement('div');
    line.className = 'msg-line';

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (msg.isRetracted) {
      bubble.classList.add('retracted');
      bubble.textContent = '此消息已被撤回';
    } else if (state.renderHtml && typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      try {
        bubble.innerHTML = DOMPurify.sanitize(marked.parse(String(msg.text || '')));
      } catch (e) {
        bubble.textContent = msg.text || '';
      }
    } else {
      bubble.innerHTML = escapeHtml(msg.text || '').split('\\n').join('<br>');
    }

    line.appendChild(bubble);

    if (mine && !msg.isRetracted && Date.now() - msg.timestamp < 120000) {
      var tools = document.createElement('span');
      tools.className = 'msg-tools';
      tools.textContent = '撤回';
      tools.addEventListener('click', function () {
        var conn = state.conns[state.activeId];
        if (!conn || !conn.ws || conn.ws.readyState !== 1) return;
        if (confirm('确定要撤回这条消息吗？')) {
          conn.ws.send(JSON.stringify({ type: 'retract', messageId: msg.messageId }));
        }
      });
      line.appendChild(tools);
    }

    body.appendChild(line);
    item.appendChild(body);
    wrap.appendChild(item);
  }

  function addSystemMessage(text, type) {
    var wrap = el('messages-inner');
    var item = document.createElement('div');
    item.className = 'sys-msg ' + (type === 'error' ? 'error' : '');
    var span = document.createElement('span');
    span.textContent = text;
    item.appendChild(span);
    wrap.appendChild(item);
    state.lastRenderedTs = 0;
  }

  function applyRetract(messageId) {
    var list = state.messages[state.activeId] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].messageId === messageId) {
        list[i].isRetracted = true;
        list[i].text = '此消息已被撤回';
      }
    }
    var target = document.querySelector('[data-message-id="' + messageId + '"]');
    if (target) {
      var bubble = target.querySelector('.bubble');
      if (bubble) {
        bubble.className = 'bubble retracted';
        bubble.textContent = '此消息已被撤回';
      }
      var tools = target.querySelector('.msg-tools');
      if (tools) tools.remove();
    }
  }

  function refreshAvatarInPlace(uid, avatar, name) {
    var nodes = document.querySelectorAll('[data-uid="' + uid + '"]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var replacement = buildAvatar(avatar, name, 'av-40');
      replacement.classList.add('msg-avatar');
      replacement.setAttribute('data-uid', uid);
      node.parentNode.replaceChild(replacement, node);
    }
    if (state.account && state.account.id === uid && avatar) {
      state.account.avatar = avatar;
    }
  }

  function scrollToBottom(force) {
    var wrap = el('messages');
    var nearBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 160;
    if (force || nearBottom) wrap.scrollTop = wrap.scrollHeight;
  }

  function showTyping(name) {
    state.typingUsers.set(name, Date.now());
    updateTypingLine();
    if (state.typingTimer) clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(function () {
      var now = Date.now();
      state.typingUsers.forEach(function (ts, key) {
        if (now - ts > 3000) state.typingUsers.delete(key);
      });
      updateTypingLine();
    }, 3200);
  }

  function updateTypingLine() {
    var names = Array.from(state.typingUsers.keys());
    var box = el('typing-indicator');
    if (!names.length) {
      box.classList.remove('on');
      box.textContent = '';
      return;
    }
    box.classList.add('on');
    if (names.length === 1) box.textContent = names[0] + ' 正在输入...';
    else if (names.length === 2) box.textContent = names.join('、') + ' 正在输入...';
    else box.textContent = '多个人正在输入...';
  }

  // ---------------- 发送 ----------------
  function sendMessage() {
    var input = el('message-input');
    var text = (input.value || '').trim();
    if (!text) return;
    var conn = state.conns[state.activeId];
    if (!conn || !conn.ws || conn.ws.readyState !== 1) {
      addSystemMessage('连接已断开，正在重连，请稍后再发送。', 'error');
      scrollToBottom(true);
      return;
    }
    conn.ws.send(JSON.stringify({ type: 'chat', text: text }));
    input.value = '';
    autoResize();
  }

  var typingSentAt = 0;
  function sendTyping() {
    var conn = state.conns[state.activeId];
    if (!conn || !conn.ws || conn.ws.readyState !== 1) return;
    var now = Date.now();
    if (now - typingSentAt < 2000) return;
    typingSentAt = now;
    conn.ws.send(JSON.stringify({ type: 'typing' }));
  }

  function autoResize() {
    var input = el('message-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  }

  // ---------------- 设置 ----------------
  function loadSettings() {
    var saved = readJSON(LS.settings, null) || {};
    state.renderHtml = saved.renderHtml === true;
    state.historyLimit = parseInt(saved.historyLimit, 10) || 50;
    el('render-html-toggle').checked = state.renderHtml;
    el('history-limit-input').value = state.historyLimit;
    el('set-name').value = state.account ? state.account.name : '';
    state.setAvatar = state.account ? (state.account.avatar || '') : '';
    renderSetAvatar();
    renderSetEmojiRow();
  }

  function renderSetAvatar() {
    var box = el('set-avatar-preview');
    box.innerHTML = '';
    box.appendChild(buildAvatar(state.setAvatar, el('set-name').value || 'Z', 'av-64'));
  }

  function renderSetEmojiRow() {
    var row = el('set-emoji-row');
    row.innerHTML = '';
    AVATAR_EMOJIS.forEach(function (emoji) {
      var item = document.createElement('div');
      item.className = 'av av-emoji' + (state.setAvatar === emoji ? ' sel' : '');
      item.textContent = emoji;
      item.addEventListener('click', function () {
        state.setAvatar = emoji;
        renderSetEmojiRow();
        renderSetAvatar();
      });
      row.appendChild(item);
    });
  }

  function saveSettings() {
    if (!state.account) return;
    var newName = (el('set-name').value || '').trim();
    if (newName.length < 2) { alert('昵称至少 2 个字符'); return; }

    var list = accounts();
    var duplicated = list.some(function (acc) {
      return acc.id !== state.account.id && acc.name === newName;
    });
    if (duplicated) { alert('这个昵称已经被占用'); return; }

    state.renderHtml = el('render-html-toggle').checked;
    state.historyLimit = parseInt(el('history-limit-input').value, 10) || 50;
    writeJSON(LS.settings, { renderHtml: state.renderHtml, historyLimit: state.historyLimit });

    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.account.id) {
        list[i].name = newName;
        list[i].avatar = state.setAvatar;
        state.account = list[i];
      }
    }
    saveAccounts(list);
    state.account = { id: state.account.id, name: newName, avatar: state.setAvatar };

    el('me-name').textContent = newName;
    var meAvatarBox = el('me-avatar');
    meAvatarBox.innerHTML = '';
    meAvatarBox.appendChild(buildAvatar(state.setAvatar, newName, 'av-44'));

    sendIdentity(state.activeId);
    state.rooms.forEach(function (room) {
      var conn = state.conns[room.id];
      if (conn && conn.ws && conn.ws.readyState === 1) {
        conn.ws.send(JSON.stringify({
          type: 'identity',
          id: state.account.id,
          name: state.account.name,
          avatar: state.account.avatar || ''
        }));
      }
    });

    renderMessages();
    closeDrawer();
  }

  function openDrawer() {
    el('set-name').value = state.account ? state.account.name : '';
    state.setAvatar = state.account ? (state.account.avatar || '') : '';
    renderSetAvatar();
    renderSetEmojiRow();
    el('settings-drawer').classList.add('open');
    el('drawer-mask').classList.add('open');
  }

  function closeDrawer() {
    el('settings-drawer').classList.remove('open');
    el('drawer-mask').classList.remove('open');
  }

  // 清空当前会话的聊天记录（服务端一并删除，对所有人生效）
  function clearCurrentRoom() {
    var room = roomById(state.activeId);
    if (!room) return;
    if (!confirm('清空「' + room.name + '」的聊天记录？')) return;
    if (!confirm('这会删除该会话里所有人的历史消息，且无法恢复。确定继续？')) return;

    state.messages[room.id] = [];
    room.last = null;
    room.unread = 0;
    if (room.id === state.activeId) {
      state.lastRenderedTs = 0;
      renderMessages();
    }
    renderConvs();

    var conn = state.conns[room.id];
    if (conn && conn.ws && conn.ws.readyState === 1) {
      conn.ws.send(JSON.stringify({ type: 'clear' }));
    }
    closeDrawer();
  }

  // 清空本机保存的群组信息，恢复为默认的会话列表
  function resetRooms() {
    if (!confirm('重置群组列表？自行创建的群聊会从列表里移除。')) return;

    Object.keys(state.conns).forEach(function (rid) { closeConn(rid); });
    state.conns = {};
    state.rooms = JSON.parse(JSON.stringify(DEFAULT_ROOMS));
    state.rooms.forEach(function (room) {
      room.unread = 0;
      room.online = 0;
      room.last = null;
      room.seenTs = Date.now();
    });
    writeJSON(LS.rooms, state.rooms);
    try {
      localStorage.removeItem(LS.seen);
      localStorage.removeItem(LS.active);
    } catch (e) {}
    state.messages = {};
    state.avatars = {};
    state.activeId = '';
    state.lastRenderedTs = 0;
    closeDrawer();
    el('conv-list').innerHTML = '';
    renderConvs();
    setActiveRoom('hall');
  }

  function logout() {
    if (!confirm('确定要退出登录吗？聊天记录会保留在云端。')) return;
    try { localStorage.removeItem(LS.session); } catch (e) {}
    Object.keys(state.conns).forEach(closeConn);
    state.conns = {};
    state.account = null;
    state.myId = '';
    el('app').style.display = 'none';
    el('auth-layer').style.display = 'flex';
    el('auth-pass').value = '';
    closeDrawer();
    el('auth-hint').textContent = '已退出登录，可以换一个账号进入。';
  }

  // ---------------- 移动端侧栏 ----------------
  function isMobile() { return window.matchMedia('(max-width: 820px)').matches; }

  function updatePlaceholder() {
    var input = el('message-input');
    if (!input) return;
    input.placeholder = isMobile() ? '发消息' : '请输入消息，Enter 发送，Shift + Enter 换行';
  }

  function toggleSidebar() {
    if (isMobile()) {
      el('app').classList.toggle('mobile-open');
    } else {
      var app = el('app');
      app.classList.toggle('collapsed');
      localStorage.setItem(LS.collapsed, app.classList.contains('collapsed') ? '1' : '0');
    }
  }

  function closeMobileSidebar() {
    el('app').classList.remove('mobile-open');
  }

  // ---------------- 事件绑定 ----------------
  var appBound = false;

  function bindAppEvents() {
    if (appBound) return;
    appBound = true;

    el('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
    el('sidebar-mask').addEventListener('click', closeMobileSidebar);
    el('btn-settings').addEventListener('click', openDrawer);
    el('btn-settings-2').addEventListener('click', openDrawer);
    el('drawer-close').addEventListener('click', closeDrawer);
    el('drawer-mask').addEventListener('click', closeDrawer);
    el('save-settings').addEventListener('click', saveSettings);
    el('btn-logout').addEventListener('click', logout);
    el('me-card').addEventListener('click', openDrawer);

    el('clear-messages').addEventListener('click', clearCurrentRoom);
    el('reset-rooms').addEventListener('click', resetRooms);

    el('send-button').addEventListener('click', sendMessage);

    var input = el('message-input');
    input.addEventListener('input', function () {
      autoResize();
      sendTyping();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });

    el('search-input').addEventListener('input', renderConvs);

    var emojiToggle = el('emoji-toggle');
    emojiToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      el('emoji-picker').classList.toggle('visible');
    });
    document.addEventListener('click', function (e) {
      var picker = el('emoji-picker');
      if (picker.classList.contains('visible') && !picker.contains(e.target) && e.target !== emojiToggle) {
        picker.classList.remove('visible');
      }
    });

    EMOJIS.forEach(function (emoji) {
      var span = document.createElement('span');
      span.textContent = emoji;
      span.addEventListener('click', function () {
        input.value += emoji;
        input.focus();
        autoResize();
      });
      el('emoji-picker').appendChild(span);
    });

    el('set-upload-btn').addEventListener('click', function () { el('set-avatar-file').click(); });
    el('set-avatar-file').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      fileToAvatar(file).then(function (dataUrl) {
        state.setAvatar = dataUrl;
        renderSetAvatar();
        renderSetEmojiRow();
      }).catch(function (err) {
        alert(err.message || '头像处理失败');
      });
      event.target.value = '';
    });

    // 新建会话
    el('btn-new-room').addEventListener('click', function () {
      el('new-room-name').value = '';
      el('new-room-modal').classList.add('open');
      setTimeout(function () { el('new-room-name').focus(); }, 60);
    });
    el('new-room-cancel').addEventListener('click', function () {
      el('new-room-modal').classList.remove('open');
    });
    el('new-room-ok').addEventListener('click', createRoom);
    el('new-room-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') createRoom();
    });

    if (localStorage.getItem(LS.collapsed) === '1' && !isMobile()) {
      el('app').classList.add('collapsed');
    }

    window.addEventListener('resize', function () {
      if (!isMobile()) closeMobileSidebar();
      updatePlaceholder();
    });
  }

  function createRoom() {
    var name = (el('new-room-name').value || '').trim();
    if (name.length < 1) { alert('请输入群聊名称'); return; }
    var id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    state.rooms.push({ id: id, name: name, group: '我的群组', emoji: '💬', unread: 0, online: 0, last: null });
    writeJSON(LS.rooms, state.rooms);
    el('new-room-modal').classList.remove('open');
    setActiveRoom(id);
  }

  // ---------------- 启动 ----------------
  function init() {
    var tabs = document.querySelectorAll('.auth-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener('click', function () { setAuthMode(tab.getAttribute('data-mode')); });
      })(tabs[i]);
    }

    el('auth-submit').addEventListener('click', submitAuth);
    el('auth-pass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitAuth();
    });
    el('auth-name').addEventListener('input', renderRegAvatar);

    el('reg-upload-btn').addEventListener('click', function () { el('reg-avatar-file').click(); });
    el('reg-avatar-file').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      fileToAvatar(file).then(function (dataUrl) {
        state.regAvatar = dataUrl;
        renderRegAvatar();
        renderRegEmojiRow();
      }).catch(function (err) {
        showAuthError(err.message || '头像处理失败');
      });
      event.target.value = '';
    });

    var list = accounts();
    var session = readJSON(LS.session, null);
    if (list.length && session && session.name) {
      el('auth-name').value = session.name;
      setAuthMode('login');
      el('auth-hint').textContent = '欢迎回来，' + session.name + '。输入密码继续。';
    } else if (!list.length) {
      setAuthMode('register');
      state.regAvatar = AVATAR_EMOJIS[0];
    } else {
      setAuthMode('login');
    }
    renderRegEmojiRow();
    renderRegAvatar();
    el('auth-name').focus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
</script>
</body>
</html>`;

export {
  ChatRoom,
  src_default as default
};
//# sourceMappingURL=index.js.map

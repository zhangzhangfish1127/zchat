var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ---------------------------------------------------------------------------
// 常量与安全工具
// ---------------------------------------------------------------------------
var MAX_TEXT_LENGTH = 4000;
var MAX_AVATAR_LENGTH = 24000;
var HISTORY_LIMIT = 100;
var DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;
var ICON_RE = /^[a-z][a-z0-9-]{1,15}$/;

// 管理员默认密码，可用 wrangler secret 覆盖：ADMIN_PASS
var ADMIN_DEFAULT_PASS = "admin123";
// 群组注册表存放在同一个 Durable Object 命名空间下，避免新增类与迁移
var REGISTRY_NAME = "registry:rooms";
var ADMIN_TOKEN_TTL = 6 * 60 * 60 * 1000;

var SEED_ROOMS = [
  { id: "hall", name: "大厅", group: "公共频道", icon: "hall" },
  { id: "tech", name: "技术交流", group: "公共频道", icon: "code" },
  { id: "random", name: "随便聊聊", group: "公共频道", icon: "chat" },
  { id: "class9", name: "9班内部群", group: "我的群组", icon: "cap" },
];

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

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

async function hashPassword(salt, password) {
  var bytes = new TextEncoder().encode(salt + ":" + password);
  var buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map(function (b) {
      return ("0" + b.toString(16)).slice(-2);
    })
    .join("");
}

function makeSalt() {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  } catch (e) {
    return String(Math.random()).slice(2, 12) + String(Date.now()).slice(-4);
  }
}

function roomStoreName(roomId) {
  return roomId === "hall" ? "global-chat-room" : "room:" + roomId;
}

// 群组对外视图：隐去密码盐与哈希
function roomView(room, uid, isAdmin) {
  var mine = !!uid && room.ownerId === uid;
  var group;
  if (room.builtin) group = room.group || "公共频道";
  else if (room.public) group = "公共频道";
  else group = mine || isAdmin ? "我的群组" : "私有群组";
  return {
    id: room.id,
    name: room.name,
    icon: room.icon || "chat",
    group: group,
    mine: mine,
    locked: !!room.hash,
    public: !!room.public,
    builtin: !!room.builtin,
    ownerId: room.ownerId || "",
    ownerName: room.ownerName || "",
    createdAt: room.createdAt || 0,
  };
}

// ---------------------------------------------------------------------------
// Backend: 每个会话 rooms 对应一个独立的 Durable Object 实例
// 另外用 "registry:rooms" 这一个实例保存群组注册表（名称里带冒号，客户端无法拼出）
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

    if (this.room === REGISTRY_NAME) {
      return this.handleRegistry(request, url);
    }

    var preview = url.searchParams.get("preview") === "1";

    if (request.headers.get("Upgrade") !== "websocket") {
      // 内部调用：群组被删除时清空该房间的消息
      if (url.searchParams.get("wipe") === "1") {
        await this.state.storage.put("messages", []);
        this.broadcast({ type: "cleared", room: this.room });
        this.clearPreview();
        return new Response("ok");
      }
      var info = await this.getInfo();
      return jsonResponse(info);
    }

    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server, preview);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------------
  // 群组注册表
  // ------------------------------------------------------------------
  async registryRooms() {
    var rooms = await this.state.storage.get("rooms");
    if (!Array.isArray(rooms) || !rooms.length) {
      var now = Date.now();
      rooms = SEED_ROOMS.map(function (seed) {
        return Object.assign({}, seed, {
          public: true,
          builtin: true,
          ownerId: "",
          ownerName: "系统",
          salt: "",
          hash: "",
          createdAt: now,
        });
      });
      await this.state.storage.put("rooms", rooms);
    }
    return rooms;
  }

  async registryIsAdmin(token) {
    var value = typeof token === "string" ? token : "";
    if (!value) return false;
    var tokens = (await this.state.storage.get("tokens")) || {};
    var exp = tokens[value];
    if (!exp) return false;
    if (exp < Date.now()) return false;
    return true;
  }

  async registryIssueToken() {
    var tokens = (await this.state.storage.get("tokens")) || {};
    var now = Date.now();
    Object.keys(tokens).forEach(function (key) {
      if (!tokens[key] || tokens[key] < now) delete tokens[key];
    });
    var token = crypto.randomUUID();
    tokens[token] = now + ADMIN_TOKEN_TTL;
    await this.state.storage.put("tokens", tokens);
    return token;
  }

  async registryWipeRoom(roomId) {
    try {
      var stub = this.env.CHAT_ROOM.get(this.env.CHAT_ROOM.idFromName(roomStoreName(roomId)));
      await stub.fetch(new Request("https://room.local/?wipe=1"));
    } catch (e) {
      // 消息清空失败不影响群组删除
    }
  }

  async handleRegistry(request, url) {
    var body = {};
    if (request.method === "POST") {
      try {
        body = (await request.json()) || {};
      } catch (e) {
        body = {};
      }
    }
    var action = String(body.action || url.searchParams.get("action") || "list");

    if (action === "admin-login") {
      var expected = String((this.env && this.env.ADMIN_PASS) || ADMIN_DEFAULT_PASS);
      if (String(body.password || "") !== expected) {
        return jsonResponse({ ok: false, error: "管理员密码不正确" }, 401);
      }
      var token = await this.registryIssueToken();
      return jsonResponse({ ok: true, token: token, expires: Date.now() + ADMIN_TOKEN_TTL });
    }

    if (action === "list") {
      var uid = String(body.uid || url.searchParams.get("uid") || "").slice(0, 64);
      var listToken = body.token || url.searchParams.get("token") || "";
      var wantAll = String(body.all || url.searchParams.get("all") || "") === "1";
      var rooms = await this.registryRooms();
      var isAdmin = await this.registryIsAdmin(listToken);
      var visible = rooms.filter(function (room) {
        if (wantAll && isAdmin) return true;
        if (room.builtin || room.public) return true;
        return !!uid && room.ownerId === uid;
      });
      return jsonResponse({
        ok: true,
        isAdmin: isAdmin,
        rooms: visible.map(function (room) {
          return roomView(room, uid, isAdmin);
        }),
      });
    }

    if (action === "verify") {
      var rooms2 = await this.registryRooms();
      var target = rooms2.find(function (room) {
        return room.id === body.id;
      });
      if (!target) return jsonResponse({ ok: false, error: "群组不存在" }, 404);
      if (!target.hash) return jsonResponse({ ok: true });
      var pass = String(body.password || "");
      if (!pass) return jsonResponse({ ok: false, error: "请输入群组密码" }, 400);
      var digest = await hashPassword(target.salt, pass);
      if (digest !== target.hash) {
        return jsonResponse({ ok: false, error: "群组密码不正确" }, 403);
      }
      return jsonResponse({ ok: true });
    }

    if (action === "create") {
      var creatorIsAdmin = await this.registryIsAdmin(body.token);
      var ownerId = String(body.uid || "").slice(0, 64);
      var name = String(body.name || "")
        .trim()
        .slice(0, 16);
      if (!name) return jsonResponse({ ok: false, error: "请输入群组名称" }, 400);
      if (!creatorIsAdmin && !ownerId) {
        return jsonResponse({ ok: false, error: "请先登录后再创建群组" }, 401);
      }
      var password = String(body.password || "");
      if (password && password.length < 4) {
        return jsonResponse({ ok: false, error: "群组密码至少 4 位" }, 400);
      }
      var icon = ICON_RE.test(String(body.icon || "")) ? String(body.icon) : "chat";
      var allRooms = await this.registryRooms();
      if (!creatorIsAdmin) {
        var owned = allRooms.filter(function (room) {
          return room.ownerId === ownerId;
        }).length;
        if (owned >= 20) {
          return jsonResponse({ ok: false, error: "最多创建 20 个自建群组" }, 400);
        }
      }
      var salt = password ? makeSalt() : "";
      var hash = password ? await hashPassword(salt, password) : "";
      var newRoom = {
        id: "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: name,
        icon: icon,
        group: "公共频道",
        public: creatorIsAdmin ? body.public !== false : false,
        builtin: false,
        ownerId: creatorIsAdmin ? "" : ownerId,
        ownerName: creatorIsAdmin ? "管理员" : String(body.ownerName || "群主").slice(0, 16),
        salt: salt,
        hash: hash,
        createdAt: Date.now(),
      };
      allRooms.push(newRoom);
      await this.state.storage.put("rooms", allRooms);
      return jsonResponse({ ok: true, room: roomView(newRoom, ownerId, creatorIsAdmin) });
    }

    if (action === "update") {
      var editorIsAdmin = await this.registryIsAdmin(body.token);
      var editorId = String(body.uid || "");
      var rooms3 = await this.registryRooms();
      var index = rooms3.findIndex(function (room) {
        return room.id === body.id;
      });
      if (index < 0) return jsonResponse({ ok: false, error: "群组不存在" }, 404);
      var record = rooms3[index];
      var editorIsOwner =
        !record.builtin && !record.public && !!editorId && record.ownerId === editorId;
      if (!editorIsAdmin && !editorIsOwner) {
        return jsonResponse({ ok: false, error: "需要管理员权限" }, 403);
      }
      if (typeof body.name === "string") {
        var newName = body.name.trim().slice(0, 16);
        if (newName) record.name = newName;
      }
      if (typeof body.icon === "string" && ICON_RE.test(body.icon)) {
        record.icon = body.icon;
      }
      if (body.clearPassword) {
        record.salt = "";
        record.hash = "";
      } else if (typeof body.password === "string" && body.password) {
        if (body.password.length < 4) {
          return jsonResponse({ ok: false, error: "群组密码至少 4 位" }, 400);
        }
        record.salt = makeSalt();
        record.hash = await hashPassword(record.salt, body.password);
      }
      rooms3[index] = record;
      await this.state.storage.put("rooms", rooms3);
      return jsonResponse({ ok: true, room: roomView(record, editorId, editorIsAdmin) });
    }

    if (action === "delete") {
      var deleterIsAdmin = await this.registryIsAdmin(body.token);
      var deleterId = String(body.uid || "");
      var rooms4 = await this.registryRooms();
      var targetIndex = rooms4.findIndex(function (room) {
        return room.id === body.id;
      });
      if (targetIndex < 0) return jsonResponse({ ok: false, error: "群组不存在" }, 404);
      var victim = rooms4[targetIndex];
      var isOwner = !victim.builtin && !victim.public && victim.ownerId === deleterId;
      if (!deleterIsAdmin && !isOwner) {
        return jsonResponse({ ok: false, error: "没有权限删除该群组" }, 403);
      }
      rooms4.splice(targetIndex, 1);
      await this.state.storage.put("rooms", rooms4);
      await this.registryWipeRoom(victim.id);
      return jsonResponse({ ok: true, id: victim.id });
    }

    return jsonResponse({ ok: false, error: "未知操作" }, 400);
  }

  // ------------------------------------------------------------------
  // 房间本身
  // ------------------------------------------------------------------
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
        var id = env.CHAT_ROOM.idFromName(roomStoreName(room));
        var stub = env.CHAT_ROOM.get(id);
        return stub.fetch(request);
      }

      if (url.pathname === "/api/info") {
        var roomId = sanitizeRoomId(url.searchParams.get("room"));
        var stubInfo = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomStoreName(roomId)));
        var res = await stubInfo.fetch(new Request("https://room.local/?room=" + roomId));
        return new Response(await res.text(), {
          headers: { "content-type": "application/json;charset=UTF-8" },
        });
      }

      // 群组注册表：列表 / 创建 / 改名 / 改密码 / 删除 / 密码校验 / 管理员登录
      if (url.pathname === "/api/rooms" || url.pathname === "/api/admin/login") {
        var registry = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(REGISTRY_NAME));
        var init = { method: request.method, headers: { "content-type": "application/json" } };
        if (request.method === "POST") {
          var raw = await request.text();
          init.body = raw || "{}";
        }
        return registry.fetch(new Request("https://registry.local" + url.pathname, init));
      }

      // 邀请码校验：邀请码只存在 Worker 密钥里，不下发给浏览器
      if (url.pathname === "/api/invite") {
        var payload = {};
        try {
          payload = (await request.json()) || {};
        } catch (e) {
          payload = {};
        }
        var expected = String((env && env.YAOQINGMA) || "").trim();
        var code = String(payload.code || "").trim();
        if (!expected) {
          return jsonResponse({
            ok: false,
            reason: "unconfigured",
            error: "服务端尚未配置邀请码",
          });
        }
        if (!code || code !== expected) {
          return jsonResponse({ ok: false, reason: "mismatch", error: "邀请码不正确" });
        }
        return jsonResponse({ ok: true });
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2307c160' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.4-.6L4 21l1.8-4.4a8 8 0 0 1-1.3-4.6A8.4 8.4 0 0 1 13 3.7 8.4 8.4 0 0 1 21 11.5Z'/%3E%3C/svg%3E">
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
  --icon: #5b5f5c;
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

/* ---------- 线稿图标 ---------- */
.ic { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
.ic svg { width: 18px; height: 18px; display: block; }
.ic-sm svg { width: 14px; height: 14px; }

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
  border: none; background: transparent; cursor: pointer; color: var(--icon);
  width: 32px; height: 32px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center; transition: background .15s, color .15s;
}
.icon-btn:hover { background: var(--hover); color: var(--text); }

.search-box { padding: 0 14px 10px; }
.search-wrap { position: relative; }
.search-wrap .ic { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: #a9a9a9; }
.search-wrap input {
  width: 100%; border: none; background: #ececec; border-radius: 6px;
  padding: 7px 11px 7px 30px; font-size: 13px; outline: none; color: var(--text);
}
.search-wrap input::placeholder { color: #a3a3a3; }

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
.conv-lock { color: #b8b8b8; display: inline-flex; align-items: center; flex-shrink: 0; }
.conv-lock svg { width: 12px; height: 12px; }
.badge {
  min-width: 17px; height: 17px; padding: 0 5px; border-radius: 9px; background: var(--danger);
  color: #fff; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.sidebar-foot { padding: 10px 14px 16px; border-top: 1px solid var(--line); display: flex; gap: 8px; }
.new-room-btn {
  flex: 1 1 auto; border: 1px dashed #cfcfcf; background: transparent; color: #5f6360;
  border-radius: 6px; padding: 9px; font-size: 13px; cursor: pointer; transition: all .15s;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.new-room-btn:hover { border-color: var(--green); color: var(--green); background: #f2fbf5; }
.admin-shortcut {
  border: 1px solid #d8e8de; background: #f3faf6; color: #2f7d54; border-radius: 6px;
  width: 38px; flex: 0 0 38px; cursor: pointer; display: none; align-items: center; justify-content: center;
}
.admin-shortcut:hover { background: #e7f6ed; }

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
.av-letter { color: #fff; }
.av-emoji { background: #e4e4e4; }
.av-pick { width: 34px; height: 34px; border-radius: 7px; cursor: pointer; border: 2px solid transparent; background: #f2f6f4; color: #4c6a5a; }
.av-pick svg { width: 70%; height: 70%; }
.av-pick.sel { border-color: var(--green); background: #eafaf0; color: #177a48; }
.room-av { background: #eaf3ee; color: #2f7d54; border-radius: 8px; }
.room-av svg { width: 56%; height: 56%; }

/* ---------- 登录层 ---------- */
.auth-layer {
  position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(1100px 560px at 18% 8%, #e6f7ec 0%, #f1f7f2 42%, #edf0ed 100%);
  padding: 20px; overflow-y: auto;
}
.auth-card {
  width: 392px; max-width: 100%; background: #fff; border-radius: 14px;
  box-shadow: 0 20px 56px rgba(31,60,42,.13); padding: 30px 30px 24px;
  animation: pop .3s cubic-bezier(.2,.9,.3,1.1);
}
@keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
.auth-brand { text-align: center; margin-bottom: 20px; }
.auth-logo {
  width: 54px; height: 54px; margin: 0 auto 12px; border-radius: 14px;
  background: linear-gradient(145deg, #28d97f, #07c160); color: #fff;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 18px rgba(7,193,96,.28);
}
.auth-logo svg { width: 27px; height: 27px; }
.auth-title { font-size: 19px; font-weight: 600; letter-spacing: .5px; }
.auth-sub { font-size: 12px; color: var(--muted); margin-top: 6px; }
.auth-tabs { display: flex; background: #f2f2f2; border-radius: 8px; padding: 3px; margin-bottom: 16px; }
.auth-tab {
  flex: 1 1 0; border: none; background: transparent; padding: 8px 0; border-radius: 6px;
  font-size: 13px; color: #666; cursor: pointer; transition: all .18s;
}
.auth-tab.active { background: #fff; color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.auth-label { display: block; font-size: 12px; color: #7a7a7a; margin: 13px 0 6px; }
.auth-input {
  width: 100%; border: 1px solid #e2e2e2; border-radius: 8px; padding: 11px 12px;
  font-size: 14px; outline: none; transition: border-color .15s, box-shadow .15s; color: var(--text);
}
.auth-input:focus { border-color: var(--green); box-shadow: 0 0 0 3px rgba(7,193,96,.1); }
.auth-btn {
  width: 100%; border: none; background: var(--green); color: #fff; border-radius: 8px;
  padding: 12px; font-size: 15px; cursor: pointer; margin-top: 18px; transition: background .15s;
}
.auth-btn:hover { background: var(--green-dark); }
.auth-btn:disabled { background: #bfbfbf; cursor: default; }
.auth-error { font-size: 12px; color: var(--danger); min-height: 16px; margin-top: 10px; }
.auth-hint { font-size: 11px; color: #a8a8a8; text-align: center; margin-top: 12px; line-height: 1.7; }
.auth-tip { font-size: 11px; color: #a8a8a8; line-height: 1.6; margin-top: 6px; }
.auth-tip b { color: #6f8a7b; font-weight: 600; }
.auth-card.mode-login .reg-only { display: none; }
.avatar-row { display: flex; align-items: center; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
.avatar-upload {
  border: 1px solid #e2e2e2; background: #fff; border-radius: 7px; padding: 7px 12px;
  font-size: 12px; color: #555; cursor: pointer; transition: all .15s;
  display: inline-flex; align-items: center; gap: 6px;
}
.avatar-upload:hover { border-color: var(--green); color: var(--green); }
.avatar-tip { font-size: 11px; color: #a8a8a8; line-height: 1.6; }
.icon-row { display: flex; flex-wrap: wrap; gap: 6px; }

/* ---------- 设置抽屉 ---------- */
.drawer-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.26); z-index: 80;
  opacity: 0; pointer-events: none; transition: opacity .25s;
}
.drawer-mask.open { opacity: 1; pointer-events: auto; }
.drawer {
  position: fixed; top: 0; right: 0; height: 100%; width: 348px; max-width: 90vw; background: #fff;
  box-shadow: -10px 0 34px rgba(0,0,0,.12); z-index: 90; display: flex; flex-direction: column;
  transform: translateX(102%); transition: transform .28s cubic-bezier(.4,0,.2,1);
}
.drawer.open { transform: none; }
.drawer-head {
  display: flex; align-items: center; justify-content: space-between; padding: 16px 18px;
  border-bottom: 1px solid var(--line); font-size: 15px; font-weight: 600; flex-shrink: 0;
}
.drawer-body { padding: 16px 18px 26px; overflow-y: auto; }
.field-label { font-size: 12px; color: #7a7a7a; margin: 18px 0 8px; display: flex; align-items: center; gap: 6px; }
.field-label:first-child { margin-top: 0; }
.text-input {
  width: 100%; border: 1px solid #e2e2e2; border-radius: 7px; padding: 9px 11px;
  font-size: 14px; outline: none; color: var(--text); background: #fff;
}
.text-input:focus { border-color: var(--green); }
.text-input:disabled { background: #f4f4f4; color: #9a9a9a; }
.primary-btn {
  width: 100%; border: none; background: var(--green); color: #fff; border-radius: 7px;
  padding: 11px; font-size: 14px; cursor: pointer; margin-top: 22px;
}
.primary-btn:hover { background: var(--green-dark); }
.ghost-btn {
  border: 1px solid #e2e2e2; background: #fff; border-radius: 7px; padding: 9px 12px;
  font-size: 13px; color: #555; cursor: pointer; transition: all .15s;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.ghost-btn:hover { border-color: #c9c9c9; background: #fafafa; }
.ghost-btn.block { display: flex; width: 100%; margin-top: 12px; }
.danger-btn {
  display: flex; width: 100%; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid #f5c6c6; background: #fff; color: var(--danger);
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
.tip { font-size: 11px; color: #aaa; line-height: 1.7; margin-top: 18px; }
.admin-badge {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #2f7d54;
  background: #eaf6ef; border-radius: 4px; padding: 2px 6px;
}

/* ---------- 模态框 ---------- */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 110;
  display: none; align-items: center; justify-content: center; padding: 20px;
}
.modal-mask.open { display: flex; }
#admin-modal { z-index: 112; }
#room-modal, #pw-modal { z-index: 118; }
.modal {
  width: 360px; max-width: 100%; background: #fff; border-radius: 12px; padding: 22px;
  box-shadow: 0 18px 50px rgba(0,0,0,.18); animation: pop .24s ease-out;
  max-height: calc(100vh - 40px); display: flex; flex-direction: column;
}
.modal.wide { width: 480px; }
.modal h4 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.modal p { margin: 0 0 14px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.modal-actions { display: flex; gap: 10px; justify-content: space-between; margin-top: 18px; align-items: center; }
.modal-actions .right { display: flex; gap: 10px; }
.modal-actions .ghost-btn, .modal-actions .primary-btn { width: auto; margin: 0; padding: 8px 18px; }
.modal-actions .danger-btn { width: auto; margin: 0; padding: 8px 14px; }
.modal .auth-label { margin-top: 12px; }
.modal-error { font-size: 12px; color: var(--danger); min-height: 16px; margin-top: 8px; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #444; margin-top: 12px; }
.check-row input { width: 16px; height: 16px; accent-color: var(--green); }

.admin-list { overflow-y: auto; margin: 4px -4px 0; padding: 0 4px; }
.admin-row { display: flex; align-items: center; gap: 10px; padding: 9px 6px; border-radius: 7px; }
.admin-row:hover { background: #f7f7f7; }
.admin-row-main { flex: 1 1 auto; min-width: 0; }
.admin-row-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.admin-row-meta { font-size: 11px; color: var(--muted); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.admin-row-actions { display: flex; gap: 2px; flex-shrink: 0; }
.admin-row .icon-btn { width: 28px; height: 28px; }
.admin-row .icon-btn svg { width: 16px; height: 16px; }

/* ---------- toast ---------- */
.toast-layer { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); z-index: 200; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
.toast {
  background: rgba(32,32,32,.88); color: #fff; font-size: 13px; padding: 9px 16px; border-radius: 7px;
  max-width: 78vw; line-height: 1.5; animation: toastIn .2s ease-out;
}
@keyframes toastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* ---------- 移动端 / 窄屏 ---------- */
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
  .drawer { width: 320px; }
}

/* ---------- 横屏优化 ---------- */
@media (orientation: landscape) and (max-height: 560px) {
  .sidebar { width: 236px; flex: 0 0 236px; }
  .app.collapsed .sidebar { margin-left: -236px; }
  .sidebar-top { padding: 9px 12px 6px; }
  .search-box { padding: 0 12px 6px; }
  .conv-group { padding: 8px 8px 4px; }
  .conv-item { padding: 6px 8px; }
  .conv-snippet { margin-top: 2px; }
  .sidebar-foot { padding: 7px 12px 9px; }
  .new-room-btn { padding: 7px; }

  .chat-header { height: 46px; }
  .chat-sub { font-size: 10.5px; margin-top: 1px; }
  .message-scroll { padding: 10px 16px 2px; }
  .msg { margin-bottom: 10px; }
  .msg-body { max-width: min(520px, 74%); }
  .bubble { padding: 7px 11px; font-size: 14px; line-height: 1.55; }
  .day-sep { margin: 8px 0 10px; }
  .composer { padding: 6px 14px 9px; gap: 6px; }
  #message-input { min-height: 34px; padding: 7px 10px; font-size: 14px; max-height: 76px; }
  .send-btn { height: 34px; padding: 0 15px; font-size: 13px; }
  .composer-tools { padding-bottom: 1px; }
  .emoji-picker { bottom: 54px; grid-template-columns: repeat(8, 30px); }

  .drawer { width: 306px; }
  .drawer-head { padding: 12px 16px; }
  .drawer-body { padding: 12px 16px 18px; }
  .field-label { margin: 12px 0 6px; }
  .text-input { padding: 7px 10px; font-size: 13px; }
  .primary-btn { margin-top: 14px; padding: 9px; }
  .ghost-btn.block, .danger-btn { margin-top: 8px; padding: 8px; }
  .tip { margin-top: 12px; }

  .auth-layer { align-items: flex-start; padding: 12px; }
  .auth-card { width: 500px; padding: 18px 22px 16px; margin: auto; }
  .auth-brand { margin-bottom: 12px; display: flex; align-items: center; justify-content: center; gap: 10px; }
  .auth-logo { width: 40px; height: 40px; margin: 0; border-radius: 11px; }
  .auth-logo svg { width: 21px; height: 21px; }
  .auth-title { font-size: 16px; }
  .auth-sub { display: none; }
  .auth-tabs { margin-bottom: 10px; padding: 2px; }
  .auth-tab { padding: 6px 0; font-size: 12.5px; }
  .auth-fields { display: grid; grid-template-columns: 1fr 1fr; column-gap: 14px; }
  .auth-label { margin: 8px 0 5px; font-size: 11.5px; }
  .auth-input { padding: 8px 10px; font-size: 13px; border-radius: 7px; }
  .auth-btn { margin-top: 12px; padding: 10px; font-size: 14px; }
  .auth-error { margin-top: 6px; min-height: 14px; }
  .auth-hint { margin-top: 8px; }
  .av-64 { width: 50px; height: 50px; }
  .av-pick { width: 30px; height: 30px; }
  .avatar-row { gap: 10px; }
  .modal { padding: 16px 18px; }
  .modal-actions { margin-top: 12px; }
}
@media (orientation: landscape) and (max-height: 430px) {
  .auth-card { width: 560px; padding: 14px 20px 12px; }
  .auth-brand { display: none; }
  .avatar-row { margin-top: 0; }
  .chat-sub { display: none; }
  .sidebar-foot { padding: 6px 12px 7px; }
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
      <button class="icon-btn" id="btn-settings" title="设置"><span class="ic" data-icon="gear"></span></button>
    </div>
    <div class="search-box">
      <div class="search-wrap">
        <span class="ic ic-sm" data-icon="search"></span>
        <input id="search-input" placeholder="搜索会话" autocomplete="off">
      </div>
    </div>
    <div class="conv-scroll" id="conv-list"></div>
    <div class="sidebar-foot">
      <button class="new-room-btn" id="btn-new-room"><span class="ic ic-sm" data-icon="plus"></span>新建群组</button>
      <button class="admin-shortcut" id="btn-admin" title="群组管理"><span class="ic" data-icon="shield"></span></button>
    </div>
  </aside>
  <div class="sidebar-mask" id="sidebar-mask"></div>

  <main class="chat">
    <header class="chat-header">
      <button class="icon-btn" id="btn-toggle-sidebar" title="收起 / 展开侧栏"><span class="ic" data-icon="menu"></span></button>
      <div class="chat-title">
        <div class="chat-name" id="chat-name">大厅</div>
        <div class="chat-sub" id="chat-sub">正在连接...</div>
      </div>
      <div class="chat-actions">
        <button class="icon-btn" id="btn-room-manage" title="群组设置" style="display:none"><span class="ic" data-icon="edit"></span></button>
        <button class="icon-btn" id="btn-settings-2" title="设置"><span class="ic" data-icon="more"></span></button>
      </div>
    </header>
    <div class="message-scroll" id="messages"><div class="messages-inner" id="messages-inner"></div></div>
    <div class="typing-line" id="typing-indicator"></div>
    <div class="composer">
      <div class="composer-tools">
        <button class="icon-btn" id="emoji-toggle" title="表情"><span class="ic" data-icon="smile"></span></button>
      </div>
      <textarea id="message-input" rows="1" placeholder="请输入消息，Enter 发送，Shift + Enter 换行" autocomplete="off"></textarea>
      <button class="send-btn" id="send-button">发送</button>
      <div class="emoji-picker" id="emoji-picker"></div>
    </div>
  </main>
</div>

<div class="auth-layer" id="auth-layer">
  <div class="auth-card mode-login" id="auth-card">
    <div class="auth-brand">
      <div class="auth-logo"><span class="ic" data-icon="bubble"></span></div>
      <div>
        <div class="auth-title">ZChat</div>
        <div class="auth-sub">实时多人聊天室</div>
      </div>
    </div>
    <div class="auth-tabs">
      <button class="auth-tab active" data-mode="login">登录</button>
      <button class="auth-tab" data-mode="register">注册</button>
    </div>

    <div class="reg-only" id="reg-avatar-block">
      <div class="avatar-row">
        <div id="reg-avatar-preview"></div>
        <div>
          <button class="avatar-upload" id="reg-upload-btn" type="button"><span class="ic ic-sm" data-icon="image"></span>导入图片</button>
          <input type="file" id="reg-avatar-file" accept="image/*" style="display:none">
          <div class="avatar-tip">也可以选一个线稿头像</div>
        </div>
      </div>
      <div class="avatar-row icon-row" id="reg-icon-row"></div>
    </div>

    <div class="auth-fields">
      <div>
        <label class="auth-label">账号</label>
        <input class="auth-input" id="auth-user" maxlength="16" placeholder="字母或数字，2-16 位" autocomplete="username">
      </div>
      <div class="reg-only">
        <label class="auth-label">昵称</label>
        <input class="auth-input" id="auth-nick" maxlength="12" placeholder="聊天中显示的名字">
      </div>
      <div>
        <label class="auth-label">密码</label>
        <input class="auth-input" id="auth-pass" type="password" maxlength="32" placeholder="至少 4 位" autocomplete="current-password">
      </div>
      <div class="reg-only">
        <label class="auth-label">邀请码</label>
        <input class="auth-input" id="auth-invite" maxlength="64" placeholder="请输入邀请码">
        <div class="auth-tip">没有邀请码？联系 <b>zhangzhangfish@163.com</b> 获取</div>
      </div>
    </div>

    <div class="auth-error" id="auth-error"></div>
    <button class="auth-btn" id="auth-submit">登录</button>
    <div class="auth-hint" id="auth-hint">账号与头像保存在本机浏览器，聊天消息保存在云端。</div>
  </div>
</div>

<div class="drawer-mask" id="drawer-mask"></div>
<div class="drawer" id="settings-drawer">
  <div class="drawer-head">
    <span>个人设置</span>
    <button class="icon-btn" id="drawer-close"><span class="ic" data-icon="close"></span></button>
  </div>
  <div class="drawer-body">
    <div class="field-label">头像</div>
    <div class="avatar-row">
      <div id="set-avatar-preview"></div>
      <div>
        <button class="ghost-btn" id="set-upload-btn" type="button"><span class="ic ic-sm" data-icon="image"></span>导入图片</button>
        <input type="file" id="set-avatar-file" accept="image/*" style="display:none">
        <div class="avatar-tip">图片会自动裁成方形并压缩</div>
      </div>
    </div>
    <div class="avatar-row icon-row" id="set-icon-row" style="margin-top:10px"></div>

    <div class="field-label">账号 <span id="admin-flag" class="admin-badge" style="display:none"><span class="ic ic-sm" data-icon="shield"></span>管理员</span></div>
    <input class="text-input" id="set-user" maxlength="16" placeholder="登录账号">
    <div class="field-label">昵称</div>
    <input class="text-input" id="set-name" maxlength="12" placeholder="聊天中显示的名字">

    <div class="field-label">显示</div>
    <div class="switch-row">
      <span>渲染富文本（Markdown / HTML）</span>
      <label class="switch"><input type="checkbox" id="render-html-toggle"><span class="slider"></span></label>
    </div>

    <div class="field-label">加载历史条数</div>
    <input class="text-input" id="history-limit-input" type="number" min="1" max="100" value="50">

    <button class="primary-btn" id="save-settings">保存</button>

    <button class="ghost-btn block" id="open-admin" style="display:none"><span class="ic ic-sm" data-icon="shield"></span>群组管理（管理员）</button>
    <button class="danger-btn" id="clear-messages" style="display:none"><span class="ic ic-sm" data-icon="trash"></span>清空本群聊天记录</button>
    <button class="ghost-btn block" id="refresh-rooms"><span class="ic ic-sm" data-icon="refresh"></span>刷新群组列表</button>
    <button class="ghost-btn block" id="btn-logout"><span class="ic ic-sm" data-icon="logout"></span>退出登录</button>
    <p class="tip" id="drawer-tip">账号、头像与本地设置保存在本机浏览器；群组列表与聊天消息保存在云端。每个会话最多保留最近 100 条消息。</p>
  </div>
</div>

<!-- 新建 / 编辑群组 -->
<div class="modal-mask" id="room-modal">
  <div class="modal">
    <h4 id="rm-title">新建群组</h4>
    <p id="rm-desc">普通用户创建的群组只有自己可见，可设置进入密码。</p>
    <label class="auth-label">群组名称</label>
    <input class="text-input" id="rm-name" maxlength="16" placeholder="例如：周末聚会">
    <label class="auth-label" id="rm-pass-label">进入密码（可留空）</label>
    <input class="text-input" id="rm-pass" maxlength="32" placeholder="留空表示无需密码">
    <label class="check-row" id="rm-clear-row" style="display:none"><input type="checkbox" id="rm-clear">清除已有密码</label>
    <label class="check-row" id="rm-public-row" style="display:none"><input type="checkbox" id="rm-public" checked>所有成员可见（公共频道）</label>
    <div class="modal-error" id="rm-error"></div>
    <div class="modal-actions">
      <button class="danger-btn" id="rm-delete" style="display:none"><span class="ic ic-sm" data-icon="trash"></span>删除</button>
      <div class="right">
        <button class="ghost-btn" id="rm-cancel">取消</button>
        <button class="primary-btn" id="rm-ok">创建</button>
      </div>
    </div>
  </div>
</div>

<!-- 群组密码 -->
<div class="modal-mask" id="pw-modal">
  <div class="modal">
    <h4 id="pw-title">输入群组密码</h4>
    <p id="pw-desc">该群组设置了进入密码。</p>
    <input class="text-input" id="pw-input" type="password" maxlength="32" placeholder="群组密码">
    <div class="modal-error" id="pw-error"></div>
    <div class="modal-actions">
      <span></span>
      <div class="right">
        <button class="ghost-btn" id="pw-cancel">取消</button>
        <button class="primary-btn" id="pw-ok">进入</button>
      </div>
    </div>
  </div>
</div>

<!-- 管理员：群组管理 -->
<div class="modal-mask" id="admin-modal">
  <div class="modal wide">
    <h4>群组管理</h4>
    <p>管理员可以修改任意群组的名称与进入密码，或直接删除。删除会连同该群的聊天记录一起清除。</p>
    <div class="admin-list" id="admin-list"></div>
    <div class="modal-actions">
      <button class="ghost-btn" id="admin-create"><span class="ic ic-sm" data-icon="plus"></span>新建群组</button>
      <div class="right">
        <button class="ghost-btn" id="admin-close">关闭</button>
      </div>
    </div>
  </div>
</div>

<div class="toast-layer" id="toast-layer"></div>

<script>
(function () {
  'use strict';

  var LS = {
    accounts: 'zchat_accounts',
    session: 'zchat_session',
    rooms: 'zchat_rooms_cache',
    active: 'zchat_active_room',
    settings: 'zchat_client_settings',
    collapsed: 'zchat_sidebar_collapsed',
    seen: 'zchat_seen',
    unlock: 'zchat_unlock'
  };

  var ADMIN_USERNAME = 'admin';

  // ---------------- 线稿图标（统一 24 网格 / 1.7 描边 / 圆头） ----------------
  var ICONS = {
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.3 14.9a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    more: '<circle cx="12" cy="5.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/>',
    close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="6.6"/><path d="m20 20-4.2-4.2"/>',
    plus: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
    users: '<path d="M15.5 20v-1.4a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.3" r="3.3"/><path d="M21 20v-1.4a4 4 0 0 0-3-3.9"/><path d="M16.4 4.2a3.3 3.3 0 0 1 0 6.2"/>',
    lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.4"/><path d="M8.2 10V7.2a3.8 3.8 0 0 1 7.6 0V10"/>',
    trash: '<path d="M4 7h16"/><path d="M9.5 7V5.2a1.2 1.2 0 0 1 1.2-1.2h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="m6.5 7 .9 12.1a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3L17.5 7"/>',
    edit: '<path d="M4 20h3.8L20 7.8a2.5 2.5 0 0 0-3.6-3.5L4 16.2V20Z"/><path d="m14.8 5.8 3.4 3.4"/>',
    logout: '<path d="m15.5 16.5 4.5-4.5-4.5-4.5"/><path d="M20 12H9.5"/><path d="M12 20H6.5A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4H12"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="9" cy="10" r="1.6"/><path d="m4.5 17.5 4.6-4.2 3.4 3 3-2.6 4 3.6"/>',
    shield: '<path d="M12 3.4 19 6v5.6c0 4.6-3.1 7.9-7 8.9-3.9-1-7-4.3-7-8.9V6l7-2.6Z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
    smile: '<circle cx="12" cy="12" r="8.4"/><path d="M8.8 14.2a4.2 4.2 0 0 0 6.4 0"/><circle cx="9.4" cy="9.8" r=".9" fill="currentColor" stroke="none"/><circle cx="14.6" cy="9.8" r=".9" fill="currentColor" stroke="none"/>',
    check: '<path d="m5.5 12.5 4.2 4.2L18.5 7.8"/>',
    key: '<circle cx="8.2" cy="15.2" r="3.6"/><path d="m10.8 12.6 7.4-7.4"/><path d="m16.2 7.2 2.2 2.2"/><path d="m14 9.4 2.2 2.2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V9h-4.5"/>',
    bubble: '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.4-.6L4 21l1.8-4.4a8 8 0 0 1-1.3-4.6A8.4 8.4 0 0 1 13 3.7 8.4 8.4 0 0 1 21 11.5Z"/>',
    chat: '<path d="M20.5 11.4c0 4-3.8 7.2-8.5 7.2-1 0-2-.1-2.9-.4L4 20l1.3-3.4a7 7 0 0 1-1.8-4.9c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 6.9Z"/>',
    hall: '<path d="M4 21V6.8A2.8 2.8 0 0 1 6.8 4H13a2 2 0 0 1 2 2v15"/><path d="M15 21V11h3.4A2.6 2.6 0 0 1 21 13.6V21"/><path d="M3 21h18"/><path d="M8 8.2h2M8 12h2M8 15.8h2"/>',
    code: '<path d="m9 9.2-3 2.8 3 2.8"/><path d="m15 9.2 3 2.8-3 2.8"/><path d="M13.2 7.4 10.8 16.6"/>',
    cap: '<path d="M3 9.3 12 5.2l9 4.1-9 4.1-9-4.1Z"/><path d="M6.6 11.4V15c0 1.9 2.4 3.2 5.4 3.2s5.4-1.3 5.4-3.2v-3.6"/><path d="M21 9.6V14"/>',
    dot: '<circle cx="12" cy="12" r="3"/>'
  };

  // 头像线稿（同样 24 网格，选中后栅格化成 base64 PNG 上传）
  var AVATAR_ICONS = [
    { id: 'cat', paths: '<path d="M5.6 9.2 5 4.6l4 2.4"/><path d="M18.4 9.2 19 4.6l-4 2.4"/><path d="M4.6 12.6a7.4 7.4 0 0 1 14.8 0v1.2a6 6 0 0 1-6 6h-2.8a6 6 0 0 1-6-6Z"/><circle cx="9.6" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="14.4" cy="12" r=".9" fill="currentColor" stroke="none"/><path d="M11 16.2h2"/><path d="M2.4 13.4h2.2M19.4 13.4h2.2"/>' },
    { id: 'panda', paths: '<circle cx="12" cy="12.6" r="7.4"/><circle cx="5.2" cy="6.8" r="2.3"/><circle cx="18.8" cy="6.8" r="2.3"/><circle cx="9.5" cy="11.8" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.5" cy="11.8" r="1.4" fill="currentColor" stroke="none"/><path d="M10.2 16.2c.7.9 2.9.9 3.6 0"/>' },
    { id: 'fox', paths: '<path d="M4.6 6.5 8 9.8"/><path d="M19.4 6.5 16 9.8"/><path d="M4.6 6.5c-.4 4.6.6 8.1 3 10.3 1.4 1.3 2.9 2 4.4 2s3-.7 4.4-2c2.4-2.2 3.4-5.7 3-10.3"/><circle cx="9.7" cy="12.4" r=".9" fill="currentColor" stroke="none"/><circle cx="14.3" cy="12.4" r=".9" fill="currentColor" stroke="none"/><path d="M10.8 16.3h2.4"/>' },
    { id: 'whale', paths: '<path d="M3.6 12.6c0-3 2.9-5.4 6.5-5.4h4c1.1 0 2.1.4 2.9 1"/><path d="M17.6 9.4c1.7 1.3 2.8 3 2.8 4.6 0 2.7-2.4 4.8-5.4 4.8-1.9 0-3.6-.8-4.6-2"/><path d="m20.4 14 2 1-1.6 1.9"/><circle cx="8.8" cy="11.6" r=".9" fill="currentColor" stroke="none"/><path d="M9.4 6.4c0-1.2 1-2.2 2.2-2.2"/>' },
    { id: 'robot', paths: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4.6V8"/><circle cx="12" cy="3.6" r="1.2"/><circle cx="9.4" cy="13" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.6" cy="13" r="1.1" fill="currentColor" stroke="none"/><path d="M9.8 16.4h4.4"/><path d="M2.8 12.2v3M21.2 12.2v3"/>' },
    { id: 'ghost', paths: '<path d="M6.2 19V11a5.8 5.8 0 0 1 11.6 0v8l-1.9-1.4-1.9 1.4-2-1.4-1.9 1.4-2-1.4-1.9 1.4Z"/><circle cx="9.6" cy="11" r=".9" fill="currentColor" stroke="none"/><circle cx="14.4" cy="11" r=".9" fill="currentColor" stroke="none"/>' },
    { id: 'alien', paths: '<path d="M12 3.6c3.5 0 6.3 2.9 6.3 6.6 0 4.4-4.3 9.2-6.3 9.2s-6.3-4.8-6.3-9.2c0-3.7 2.8-6.6 6.3-6.6Z"/><path d="M8.3 10.6c.9-1.2 2-1.2 2.9 0"/><path d="M12.8 10.6c.9-1.2 2-1.2 2.9 0"/><path d="M10.7 15.4h2.6"/>' },
    { id: 'flower', paths: '<circle cx="12" cy="12" r="2.5"/><path d="M12 9.5c0-2.6 1-4 2.6-4s2.1 3.2-.5 5"/><path d="M12 14.5c0 2.6-1 4-2.6 4s-2.1-3.2.5-5"/><path d="M9.5 12c-2.6 0-4-1-4-2.6s3.2-2.1 5 .5"/><path d="M14.5 12c2.6 0 4 1 4 2.6s-3.2 2.1-5-.5"/>' },
    { id: 'leaf', paths: '<path d="M5.4 18.6c-.6-7.8 4.6-13 13.2-13 .4 8-5 13.6-13.2 13Z"/><path d="M5.8 18.2c2.4-4 5.9-6.9 9.8-8.4"/>' },
    { id: 'headset', paths: '<path d="M4.6 15v-2.6a7.4 7.4 0 0 1 14.8 0V15"/><rect x="2.9" y="13.9" width="4.2" height="6.2" rx="2.1"/><rect x="16.9" y="13.9" width="4.2" height="6.2" rx="2.1"/>' },
    { id: 'mushroom', paths: '<path d="M4.3 12.4c0-4 3.5-7 7.7-7s7.7 3 7.7 7c0 1-1 1.6-2.4 1.6H6.7c-1.4 0-2.4-.6-2.4-1.6Z"/><path d="M9.5 14v4.3c0 1.2 1.1 2.2 2.5 2.2s2.5-1 2.5-2.2V14"/>' },
    { id: 'shield', paths: '<path d="M12 3.4 19 6v5.6c0 4.6-3.1 7.9-7 8.9-3.9-1-7-4.3-7-8.9V6l7-2.6Z"/><path d="m9.2 12 2 2 3.6-3.8"/>' },
    { id: 'star', paths: '<path d="m12 4 2.4 5.1 5.4.8-3.9 3.8 1 5.5-4.9-2.7-4.9 2.7 1-5.5L4.2 9.9l5.4-.8L12 4Z"/>' }
  ];

  var EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥', '💯', '🤔', '😊', '🥳', '🤯', '🤣', '🙌', '✨'];

  var el = function (id) { return document.getElementById(id); };

  var state = {
    account: null,
    myId: '',
    isAdmin: false,
    adminToken: '',
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
    lastRenderedTs: 0,
    pendingRoomId: '',
    editingRoom: null,
    roomFormMode: 'create'
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

  function iconSvg(name) {
    var body = ICONS[name] || ICONS.dot;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  function iconSvgPathOnly(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  function paintIcons(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.getAttribute('data-painted') === '1') continue;
      node.innerHTML = iconSvg(node.getAttribute('data-icon'));
      node.setAttribute('data-painted', '1');
    }
  }

  function avatarIconById(id) {
    for (var i = 0; i < AVATAR_ICONS.length; i++) {
      if (AVATAR_ICONS[i].id === id) return AVATAR_ICONS[i];
    }
    return AVATAR_ICONS[0];
  }

  var iconAvatarCache = {};
  function iconAvatarUrl(id) {
    if (iconAvatarCache[id]) return Promise.resolve(iconAvatarCache[id]);
    return new Promise(function (resolve) {
      var item = avatarIconById(id);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">' +
        '<rect width="72" height="72" rx="12" fill="#eef6f1"/>' +
        '<g transform="translate(14 14) scale(1.83)" fill="none" stroke="#3d6b52" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        item.paths + '</g></svg>';
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = 72;
          canvas.height = 72;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 72, 72);
          var url = canvas.toDataURL('image/png');
          iconAvatarCache[id] = url;
          resolve(url);
        } catch (e) {
          resolve('');
        }
      };
      img.onerror = function () { resolve(''); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
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

  function roomAvatar(room, sizeClass) {
    var box = document.createElement('div');
    box.className = 'av room-av ' + (sizeClass || 'av-42');
    box.innerHTML = iconSvg(room.icon || 'chat');
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

  function toast(text) {
    var layer = el('toast-layer');
    var node = document.createElement('div');
    node.className = 'toast';
    node.textContent = text;
    layer.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 2600);
  }

  function api(path, body) {
    var opts = { method: 'GET', headers: {} };
    if (body) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (data) {
        return data || {};
      }).catch(function () {
        return { ok: false, error: '服务返回异常' };
      });
    }).catch(function () {
      return { ok: false, error: '网络异常，请稍后再试' };
    });
  }

  // ---------------- 账号 ----------------
  function accounts() {
    var list = readJSON(LS.accounts, []);
    return Array.isArray(list) ? list : [];
  }

  function saveAccounts(list) { writeJSON(LS.accounts, list); }

  function accountUsername(acc) { return String(acc.username || acc.name || ''); }
  function accountNickname(acc) { return String(acc.nickname || acc.name || ''); }

  function findAccount(username) {
    var list = accounts();
    var target = String(username || '').toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (accountUsername(list[i]).toLowerCase() === target) return list[i];
    }
    return null;
  }

  function ensureAdminAccount() {
    var existing = findAccount(ADMIN_USERNAME);
    if (existing) {
      if (!existing.isAdmin) {
        var l0 = accounts();
        for (var i = 0; i < l0.length; i++) {
          if (accountUsername(l0[i]).toLowerCase() === ADMIN_USERNAME) {
            l0[i].isAdmin = true;
            l0[i].username = ADMIN_USERNAME;
          }
        }
        saveAccounts(l0);
      }
      return Promise.resolve(existing);
    }
    var salt = Math.random().toString(36).slice(2, 10);
    return sha256(salt + ':admin123').then(function (hash) {
      return iconAvatarUrl('shield').then(function (avatar) {
        var acc = {
          id: 'admin-local',
          username: ADMIN_USERNAME,
          nickname: '管理员',
          salt: salt,
          hash: hash,
          avatar: avatar || '',
          isAdmin: true,
          createdAt: Date.now()
        };
        var list = accounts();
        list.push(acc);
        saveAccounts(list);
        return acc;
      });
    });
  }

  // ---------------- 登录 / 注册 ----------------
  var authMode = 'login';

  function setAuthMode(mode) {
    authMode = mode;
    var tabs = document.querySelectorAll('.auth-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mode') === mode);
    }
    el('auth-card').className = 'auth-card mode-' + mode;
    el('auth-submit').textContent = mode === 'register' ? '注册并进入' : '登录';
    el('auth-pass').placeholder = mode === 'register' ? '设置密码（至少 4 位）' : '请输入密码';
    el('auth-error').textContent = '';
  }

  function renderRegAvatar() {
    var preview = el('reg-avatar-preview');
    preview.innerHTML = '';
    preview.appendChild(buildAvatar(state.regAvatar, el('auth-nick').value || el('auth-user').value || 'Z', 'av-64'));
  }

  function renderRegIconRow() {
    var row = el('reg-icon-row');
    row.innerHTML = '';
    AVATAR_ICONS.forEach(function (item) {
      var box = document.createElement('div');
      box.className = 'av av-pick' + (iconAvatarCache[item.id] && state.regAvatar === iconAvatarCache[item.id] ? ' sel' : '');
      box.innerHTML = iconSvgPathOnly(item.paths);
      box.addEventListener('click', function () {
        iconAvatarUrl(item.id).then(function (url) {
          if (!url) return;
          state.regAvatar = url;
          renderRegAvatar();
          renderRegIconRow();
        });
      });
      row.appendChild(box);
    });
  }

  function renderSetIconRow() {
    var row = el('set-icon-row');
    row.innerHTML = '';
    AVATAR_ICONS.forEach(function (item) {
      var box = document.createElement('div');
      box.className = 'av av-pick' + (iconAvatarCache[item.id] && state.setAvatar === iconAvatarCache[item.id] ? ' sel' : '');
      box.innerHTML = iconSvgPathOnly(item.paths);
      box.addEventListener('click', function () {
        iconAvatarUrl(item.id).then(function (url) {
          if (!url) return;
          state.setAvatar = url;
          renderSetAvatar();
          renderSetIconRow();
        });
      });
      row.appendChild(box);
    });
  }

  function showAuthError(text) {
    el('auth-error').textContent = text || '';
  }

  function inviteErrorText(res) {
    if (res && res.reason === 'unconfigured') {
      return '服务端尚未配置邀请码（YAOQINGMA），请联系 zhangzhangfish@163.com';
    }
    if (res && res.reason === 'mismatch') return '邀请码不正确，请联系 zhangzhangfish@163.com 获取';
    return (res && res.error) || '邀请码校验失败，请稍后再试';
  }

  function requestAdminToken(password) {
    return api('/api/admin/login', { password: password }).then(function (res) {
      if (res && res.ok && res.token) {
        state.adminToken = res.token;
        return res.token;
      }
      throw new Error((res && res.error) || '管理员校验失败');
    });
  }

  function submitAuth() {
    var username = (el('auth-user').value || '').trim();
    var password = el('auth-pass').value || '';
    showAuthError('');
    if (!username) { showAuthError('请输入账号'); return; }
    if (password.length < 4) { showAuthError('密码至少 4 位'); return; }

    var btn = el('auth-submit');
    btn.disabled = true;

    if (authMode === 'register') {
      var nickname = (el('auth-nick').value || '').trim();
      var invite = (el('auth-invite').value || '').trim();
      if (!/^[A-Za-z0-9_]{2,16}$/.test(username)) {
        btn.disabled = false;
        showAuthError('账号需为 2-16 位字母、数字或下划线');
        return;
      }
      if (username.toLowerCase() === ADMIN_USERNAME) {
        btn.disabled = false;
        showAuthError('该账号为系统保留，请换一个');
        return;
      }
      if (nickname.length < 1) {
        btn.disabled = false;
        showAuthError('请输入昵称');
        return;
      }
      if (findAccount(username)) {
        btn.disabled = false;
        showAuthError('该账号已注册，请直接登录');
        return;
      }
      if (!invite) {
        btn.disabled = false;
        showAuthError('请输入邀请码，可联系 zhangzhangfish@163.com 获取');
        return;
      }

      api('/api/invite', { code: invite }).then(function (res) {
        if (!res.ok) {
          btn.disabled = false;
          showAuthError(inviteErrorText(res));
          return;
        }
        var salt = Math.random().toString(36).slice(2, 10);
        return sha256(salt + ':' + password).then(function (hash) {
          var account = {
            id: (crypto.randomUUID ? crypto.randomUUID() : 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
            username: username,
            nickname: nickname,
            salt: salt,
            hash: hash,
            avatar: state.regAvatar || '',
            isAdmin: false,
            createdAt: Date.now()
          };
          iconAvatarUrl('cat').then(function (fallbackAvatar) {
            if (!account.avatar) account.avatar = fallbackAvatar || '';
            var next = accounts();
            next.push(account);
            saveAccounts(next);
            btn.disabled = false;
            enterApp(account);
          });
        });
      }).catch(function () {
        btn.disabled = false;
        showAuthError('注册失败，请检查网络后重试');
      });
      return;
    }

    var found = findAccount(username);
    if (!found) {
      btn.disabled = false;
      showAuthError('该账号尚未注册，请先切换到注册');
      return;
    }
    sha256(found.salt + ':' + password).then(function (hash) {
      if (hash !== found.hash) {
        btn.disabled = false;
        showAuthError('密码不正确');
        return;
      }
      if (found.isAdmin) {
        requestAdminToken(password).then(function () {
          btn.disabled = false;
          enterApp(found);
        }).catch(function (err) {
          btn.disabled = false;
          toast(err.message || '管理员权限校验失败，群组管理暂不可用');
          enterApp(found);
        });
        return;
      }
      btn.disabled = false;
      enterApp(found);
    });
  }

  function enterApp(account) {
    state.account = account;
    state.myId = account.id;
    state.isAdmin = !!account.isAdmin;
    state.regAvatar = account.avatar || '';
    writeJSON(LS.session, { username: accountUsername(account), at: Date.now() });

    el('auth-layer').style.display = 'none';
    el('app').style.display = 'flex';
    paintIcons();

    renderMeCard();
    loadSettings();
    bindAppEvents();
    updatePlaceholder();

    if (state.isAdmin) {
      el('btn-admin').style.display = 'inline-flex';
      el('open-admin').style.display = 'flex';
      el('admin-flag').style.display = 'inline-flex';
      el('set-user').disabled = true;
      el('drawer-tip').textContent = '管理员账号固定为 admin，密码可通过 wrangler 的 ADMIN_PASS 密钥调整；群组与密码保存在云端。';
    } else {
      el('btn-admin').style.display = 'none';
      el('open-admin').style.display = 'none';
      el('admin-flag').style.display = 'none';
      el('set-user').disabled = false;
      el('drawer-tip').textContent = '账号、头像与本地设置保存在本机浏览器；群组列表与聊天消息保存在云端。每个会话最多保留最近 100 条消息。';
    }

    restoreRooms();
    refreshRooms().then(function () {
      var saved = localStorage.getItem(LS.active);
      var target = '';
      if (saved) {
        var candidate = roomById(saved);
        if (candidate && (!candidate.locked || state.isAdmin || isUnlocked(candidate.id))) target = saved;
      }
      if (!target) {
        for (var i = 0; i < state.rooms.length; i++) {
          var room = state.rooms[i];
          if (!room.locked || state.isAdmin || isUnlocked(room.id)) { target = room.id; break; }
        }
      }
      if (!target && state.rooms.length) target = state.rooms[0].id;
      if (target) openRoom(target);
    });
  }

  function renderMeCard() {
    if (!state.account) return;
    el('me-name').textContent = accountNickname(state.account);
    var idText = 'ID ' + String(state.myId).slice(0, 8);
    if (state.isAdmin) idText = '管理员 · ' + idText;
    el('me-id').textContent = idText;
    var box = el('me-avatar');
    box.innerHTML = '';
    box.appendChild(buildAvatar(state.account.avatar, accountNickname(state.account), 'av-44'));
  }

  function logout() {
    if (!confirm('确定要退出登录吗？聊天记录会保留在云端。')) return;
    try { localStorage.removeItem(LS.session); } catch (e) {}
    Object.keys(state.conns).forEach(closeConn);
    state.conns = {};
    state.account = null;
    state.myId = '';
    state.isAdmin = false;
    state.adminToken = '';
    state.rooms = [];
    state.messages = {};
    el('app').style.display = 'none';
    el('auth-layer').style.display = 'flex';
    el('auth-pass').value = '';
    closeDrawer();
    setAuthMode('login');
    el('auth-hint').textContent = '已退出登录，可以换一个账号进入。';
    fillSavedUsername();
  }

  function fillSavedUsername() {
    var session = readJSON(LS.session, null);
    if (session && session.username) {
      el('auth-user').value = session.username;
      el('auth-hint').textContent = '欢迎回来，' + session.username + '。输入密码继续。';
    }
  }

  // ---------------- 群组列表 ----------------
  function roomById(id) {
    for (var i = 0; i < state.rooms.length; i++) {
      if (state.rooms[i].id === id) return state.rooms[i];
    }
    return null;
  }

  function stripRuntime(room) {
    return {
      id: room.id, name: room.name, icon: room.icon, group: room.group,
      locked: room.locked, public: room.public, builtin: room.builtin,
      ownerId: room.ownerId, ownerName: room.ownerName, mine: room.mine
    };
  }

  function restoreRooms() {
    var cached = readJSON(LS.rooms, null);
    if (Array.isArray(cached) && cached.length) mergeRooms(cached, true);
  }

  function mergeRooms(list, fromCache) {
    var prev = {};
    state.rooms.forEach(function (room) { prev[room.id] = room; });
    var seen = readJSON(LS.seen, {}) || {};
    state.rooms = list.map(function (item) {
      var old = prev[item.id];
      return {
        id: item.id,
        name: item.name,
        icon: item.icon || 'chat',
        group: item.group || '我的群组',
        locked: !!item.locked,
        public: !!item.public,
        builtin: !!item.builtin,
        ownerId: item.ownerId || '',
        ownerName: item.ownerName || '',
        mine: !!item.mine,
        unread: old ? (old.unread || 0) : 0,
        online: old ? (old.online || 0) : 0,
        last: old ? (old.last || null) : null,
        seenTs: (old && old.seenTs) || seen[item.id] || Date.now()
      };
    });

    Object.keys(state.conns).forEach(function (rid) {
      if (!roomById(rid)) closeConn(rid);
    });

    if (!fromCache) writeJSON(LS.rooms, state.rooms.map(stripRuntime));

    renderConvs();
    updateHeader();
    if (state.activeId && !roomById(state.activeId) && state.rooms.length) {
      openRoom(state.rooms[0].id);
    }
  }

  function refreshRooms() {
    return api('/api/rooms?uid=' + encodeURIComponent(state.myId)).then(function (res) {
      if (!res || !res.ok || !Array.isArray(res.rooms)) return;
      mergeRooms(res.rooms, false);
    });
  }

  function canManageRoom(room) {
    if (!room || !state.account) return false;
    if (state.isAdmin) return true;
    return !room.builtin && !room.public && room.ownerId === state.myId;
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
      empty.textContent = state.rooms.length ? '没有匹配的会话' : '暂无群组，点击下方新建';
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
        item.appendChild(roomAvatar(room, 'av-42'));

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
          snippet.textContent = room.locked ? '需要密码进入' : '暂无消息';
        }
        row2.appendChild(snippet);
        if (room.locked) {
          var lock = document.createElement('span');
          lock.className = 'conv-lock';
          lock.innerHTML = iconSvg('lock');
          row2.appendChild(lock);
        }
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
          openRoom(room.id);
          closeMobileSidebar();
        });

        wrap.appendChild(item);
      });
    });
  }

  // ---------------- 群组密码门 ----------------
  function unlockedMap() {
    try { return JSON.parse(sessionStorage.getItem(LS.unlock) || '{}') || {}; } catch (e) { return {}; }
  }

  function isUnlocked(id) { return !!unlockedMap()[id]; }

  function markUnlocked(id) {
    var map = unlockedMap();
    map[id] = 1;
    try { sessionStorage.setItem(LS.unlock, JSON.stringify(map)); } catch (e) {}
  }

  function openRoom(id) {
    var room = roomById(id);
    if (!room) return;
    if (room.locked && !state.isAdmin && !isUnlocked(room.id)) {
      state.pendingRoomId = id;
      el('pw-title').textContent = '进入「' + room.name + '」';
      el('pw-desc').textContent = '该群组设置了进入密码，请输入密码继续。';
      el('pw-input').value = '';
      el('pw-error').textContent = '';
      el('pw-modal').classList.add('open');
      setTimeout(function () { el('pw-input').focus(); }, 60);
      return;
    }
    activateRoom(id);
  }

  function submitRoomPassword() {
    var room = roomById(state.pendingRoomId);
    if (!room) return;
    var password = el('pw-input').value || '';
    if (!password) { el('pw-error').textContent = '请输入密码'; return; }
    api('/api/rooms', { action: 'verify', id: room.id, password: password }).then(function (res) {
      if (!res.ok) {
        el('pw-error').textContent = res.error || '密码不正确';
        return;
      }
      markUnlocked(room.id);
      el('pw-modal').classList.remove('open');
      activateRoom(room.id);
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

  function identityPayload() {
    return {
      type: 'identity',
      id: state.account.id,
      name: accountNickname(state.account),
      avatar: state.account.avatar || ''
    };
  }

  function sendIdentity(roomId) {
    var conn = state.conns[roomId];
    if (!conn || !conn.ws || conn.ws.readyState !== 1) return;
    if (!state.account) return;
    conn.ws.send(JSON.stringify(identityPayload()));
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
  function activateRoom(roomId) {
    var room = roomById(roomId);
    if (!room) return;

    if (state.activeId && state.activeId !== roomId) {
      var oldRoom = roomById(state.activeId);
      if (oldRoom) markSeen(oldRoom);
    }

    state.activeId = roomId;
    localStorage.setItem(LS.active, roomId);

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
    if (!room) {
      el('chat-name').textContent = '未选择群组';
      el('chat-sub').textContent = '请在左侧选择或新建一个群组';
      el('btn-room-manage').style.display = 'none';
      el('clear-messages').style.display = 'none';
      return;
    }
    el('chat-name').textContent = room.name;
    var parts = [];
    if (room.online) parts.push(room.online + ' 人在线');
    parts.push(room.locked ? '已设密码' : '开放群组');
    if (typeof room.remaining === 'number') parts.push('今日剩余 ' + room.remaining.toLocaleString());
    el('chat-sub').textContent = parts.join(' · ');
    el('btn-room-manage').style.display = canManageRoom(room) ? 'inline-flex' : 'none';
    el('clear-messages').style.display = canManageRoom(room) ? 'flex' : 'none';
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
    var placeholder = wrap.querySelector('.empty-hint');
    if (placeholder) placeholder.remove();
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
    var max = window.matchMedia('(orientation: landscape) and (max-height: 560px)').matches ? 76 : 132;
    input.style.height = Math.min(input.scrollHeight, max) + 'px';
  }

  // ---------------- 设置 ----------------
  function loadSettings() {
    var saved = readJSON(LS.settings, null) || {};
    state.renderHtml = saved.renderHtml === true;
    state.historyLimit = parseInt(saved.historyLimit, 10) || 50;
    el('render-html-toggle').checked = state.renderHtml;
    el('history-limit-input').value = state.historyLimit;
    el('set-user').value = state.account ? accountUsername(state.account) : '';
    el('set-name').value = state.account ? accountNickname(state.account) : '';
    state.setAvatar = state.account ? (state.account.avatar || '') : '';
    renderSetAvatar();
    renderSetIconRow();
  }

  function renderSetAvatar() {
    var box = el('set-avatar-preview');
    box.innerHTML = '';
    box.appendChild(buildAvatar(state.setAvatar, el('set-name').value || 'Z', 'av-64'));
  }

  function saveSettings() {
    if (!state.account) return;
    var newUser = (el('set-user').value || '').trim();
    var newNick = (el('set-name').value || '').trim();

    if (!state.isAdmin) {
      if (!/^[A-Za-z0-9_]{2,16}$/.test(newUser)) { alert('账号需为 2-16 位字母、数字或下划线'); return; }
      if (newUser.toLowerCase() === ADMIN_USERNAME) { alert('该账号为系统保留'); return; }
      var other = findAccount(newUser);
      if (other && other.id !== state.account.id) { alert('这个账号已经被占用'); return; }
    }
    if (newNick.length < 1) { alert('请输入昵称'); return; }

    state.renderHtml = el('render-html-toggle').checked;
    state.historyLimit = parseInt(el('history-limit-input').value, 10) || 50;
    writeJSON(LS.settings, { renderHtml: state.renderHtml, historyLimit: state.historyLimit });

    var list = accounts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.account.id) {
        if (!state.isAdmin) list[i].username = newUser;
        list[i].nickname = newNick;
        list[i].name = newNick;
        list[i].avatar = state.setAvatar;
        state.account = list[i];
        break;
      }
    }
    saveAccounts(list);
    if (state.account && !state.account.username) state.account.username = newUser;

    writeJSON(LS.session, { username: accountUsername(state.account), at: Date.now() });
    renderMeCard();

    state.rooms.forEach(function (room) {
      var conn = state.conns[room.id];
      if (conn && conn.ws && conn.ws.readyState === 1) {
        conn.ws.send(JSON.stringify(identityPayload()));
      }
    });

    renderMessages();
    renderSetIconRow();
    closeDrawer();
    toast('资料已更新');
  }

  function openDrawer() {
    if (!state.account) return;
    el('set-user').value = accountUsername(state.account);
    el('set-name').value = accountNickname(state.account);
    state.setAvatar = state.account.avatar || '';
    renderSetAvatar();
    renderSetIconRow();
    updateHeader();
    el('settings-drawer').classList.add('open');
    el('drawer-mask').classList.add('open');
  }

  function closeDrawer() {
    el('settings-drawer').classList.remove('open');
    el('drawer-mask').classList.remove('open');
  }

  function clearCurrentRoom() {
    var room = roomById(state.activeId);
    if (!room || !canManageRoom(room)) return;
    if (!confirm('清空「' + room.name + '」的聊天记录？')) return;
    if (!confirm('这会删除该群所有人的历史消息，且无法恢复。确定继续？')) return;

    state.messages[room.id] = [];
    room.last = null;
    room.unread = 0;
    state.lastRenderedTs = 0;
    renderMessages();
    renderConvs();

    var conn = state.conns[room.id];
    if (conn && conn.ws && conn.ws.readyState === 1) {
      conn.ws.send(JSON.stringify({ type: 'clear' }));
    }
    closeDrawer();
  }

  // ---------------- 群组新建 / 编辑 / 删除 ----------------
  function openRoomModal(mode, room) {
    state.roomFormMode = mode;
    state.editingRoom = room || null;
    el('rm-error').textContent = '';
    el('rm-pass').value = '';
    el('rm-clear').checked = false;

    if (mode === 'create') {
      el('rm-title').textContent = state.isAdmin ? '新建群组' : '新建私人群组';
      el('rm-desc').textContent = state.isAdmin
        ? '管理员创建的群组默认对所有成员可见，可设置进入密码。'
        : '只有你自己能看到这个群组，可设置进入密码，其他成员无法加入。';
      el('rm-name').value = '';
      el('rm-delete').style.display = 'none';
      el('rm-ok').textContent = '创建';
      el('rm-clear-row').style.display = 'none';
      el('rm-public-row').style.display = state.isAdmin ? 'flex' : 'none';
      el('rm-public').checked = true;
    } else {
      el('rm-title').textContent = '群组设置';
      el('rm-desc').textContent = '修改群组名称与进入密码。' + (room.builtin ? '这是系统自带群组。' : '');
      el('rm-name').value = room.name;
      el('rm-delete').style.display = 'flex';
      el('rm-ok').textContent = '保存';
      el('rm-clear-row').style.display = room.locked ? 'flex' : 'none';
      el('rm-public-row').style.display = 'none';
    }
    el('room-modal').classList.add('open');
    setTimeout(function () { el('rm-name').focus(); }, 60);
  }

  function submitRoomForm() {
    var name = (el('rm-name').value || '').trim();
    var password = el('rm-pass').value || '';
    if (!name) { el('rm-error').textContent = '请输入群组名称'; return; }
    if (password && password.length < 4) { el('rm-error').textContent = '密码至少 4 位'; return; }

    if (state.roomFormMode === 'create') {
      var payload = {
        action: 'create',
        uid: state.myId,
        ownerName: accountNickname(state.account),
        name: name,
        password: password,
        token: state.adminToken
      };
      if (state.isAdmin) payload.public = el('rm-public').checked;
      api('/api/rooms', payload).then(function (res) {
        if (!res.ok) { el('rm-error').textContent = res.error || '创建失败'; return; }
        el('room-modal').classList.remove('open');
        closeDrawer();
        if (res.room && res.room.id) markUnlocked(res.room.id);
        refreshRooms().then(function () {
          if (res.room && res.room.id) activateRoom(res.room.id);
        });
        toast('群组已创建');
      });
      return;
    }

    var edit = state.editingRoom;
    if (!edit) return;
    var update = { action: 'update', id: edit.id, uid: state.myId, name: name, token: state.adminToken };
    if (el('rm-clear').checked) update.clearPassword = true;
    else if (password) update.password = password;

    api('/api/rooms', update).then(function (res) {
      if (!res.ok) { el('rm-error').textContent = res.error || '保存失败'; return; }
      el('room-modal').classList.remove('open');
      if (update.clearPassword || update.password) markUnlocked(edit.id);
      refreshRooms().then(function () {
        updateHeader();
        if (el('admin-modal').classList.contains('open')) renderAdminList();
      });
      toast('已保存');
    });
  }

  function deleteEditingRoom() {
    var room = state.editingRoom;
    if (!room) return;
    if (!confirm('删除群组「' + room.name + '」？聊天记录会一并清除。')) return;
    api('/api/rooms', {
      action: 'delete',
      id: room.id,
      uid: state.myId,
      token: state.adminToken
    }).then(function (res) {
      if (!res.ok) { el('rm-error').textContent = res.error || '删除失败'; return; }
      el('room-modal').classList.remove('open');
      closeDrawer();
      var removedActive = state.activeId === room.id;
      if (removedActive) {
        state.activeId = '';
        closeConn(room.id);
      }
      var adminOpen = el('admin-modal').classList.contains('open');
      refreshRooms().then(function () {
        if (adminOpen) renderAdminList();
        if (removedActive && state.rooms.length) activateRoom(state.rooms[0].id);
      });
      toast('群组已删除');
    });
  }

  // ---------------- 管理员：群组管理 ----------------
  function openAdminModal() {
    if (!state.isAdmin) return;
    el('admin-list').innerHTML = '<div class="admin-row-meta">正在加载...</div>';
    el('admin-modal').classList.add('open');
    renderAdminList();
  }

  function renderAdminList() {
    api('/api/rooms?all=1&uid=' + encodeURIComponent(state.myId) + '&token=' + encodeURIComponent(state.adminToken)).then(function (res) {
      var wrap = el('admin-list');
      wrap.innerHTML = '';
      if (!res.ok || !Array.isArray(res.rooms)) {
        wrap.innerHTML = '<div class="admin-row-meta">加载失败，请重新登录后再试</div>';
        return;
      }
      res.rooms.forEach(function (room) {
        var row = document.createElement('div');
        row.className = 'admin-row';
        row.appendChild(roomAvatar(room, 'av-40'));

        var main = document.createElement('div');
        main.className = 'admin-row-main';
        var nameEl = document.createElement('div');
        nameEl.className = 'admin-row-name';
        nameEl.textContent = room.name;
        var meta = document.createElement('div');
        meta.className = 'admin-row-meta';
        var bits = [];
        bits.push(room.builtin ? '系统群组' : (room.public ? '公共群组' : '私有群组'));
        bits.push(room.locked ? '已设密码' : '无密码');
        if (room.ownerName) bits.push('创建者 ' + room.ownerName);
        meta.textContent = bits.join(' · ');
        main.appendChild(nameEl);
        main.appendChild(meta);
        row.appendChild(main);

        var actions = document.createElement('div');
        actions.className = 'admin-row-actions';

        var editBtn = document.createElement('button');
        editBtn.className = 'icon-btn';
        editBtn.title = '编辑';
        editBtn.innerHTML = iconSvg('edit');
        editBtn.addEventListener('click', function () {
          openRoomModal('edit', room);
        });
        actions.appendChild(editBtn);

        var delBtn = document.createElement('button');
        delBtn.className = 'icon-btn';
        delBtn.title = '删除';
        delBtn.innerHTML = iconSvg('trash');
        delBtn.addEventListener('click', function () {
          state.editingRoom = room;
          deleteEditingRoom();
        });
        actions.appendChild(delBtn);

        row.appendChild(actions);
        wrap.appendChild(row);
      });
      if (!res.rooms.length) {
        wrap.innerHTML = '<div class="admin-row-meta">还没有任何群组</div>';
      }
    });
  }

  // ---------------- 侧栏 / 视口 ----------------
  function isMobile() { return window.matchMedia('(max-width: 820px)').matches; }

  function updatePlaceholder() {
    var input = el('message-input');
    if (!input) return;
    var short = window.matchMedia('(orientation: landscape) and (max-height: 560px)').matches;
    input.placeholder = isMobile() || short ? '发消息' : '请输入消息，Enter 发送，Shift + Enter 换行';
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
    el('refresh-rooms').addEventListener('click', function () {
      refreshRooms().then(function () { toast('群组列表已刷新'); });
    });
    el('btn-admin').addEventListener('click', openAdminModal);
    el('open-admin').addEventListener('click', function () {
      closeDrawer();
      openAdminModal();
    });
    el('admin-close').addEventListener('click', function () {
      el('admin-modal').classList.remove('open');
    });
    el('admin-create').addEventListener('click', function () {
      openRoomModal('create', null);
    });

    el('btn-room-manage').addEventListener('click', function () {
      var room = roomById(state.activeId);
      if (!room || !canManageRoom(room)) return;
      openRoomModal('edit', room);
    });

    el('rm-cancel').addEventListener('click', function () {
      el('room-modal').classList.remove('open');
    });
    el('rm-ok').addEventListener('click', submitRoomForm);
    el('rm-delete').addEventListener('click', deleteEditingRoom);
    el('rm-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitRoomForm();
    });

    el('pw-cancel').addEventListener('click', function () {
      el('pw-modal').classList.remove('open');
      state.pendingRoomId = '';
    });
    el('pw-ok').addEventListener('click', submitRoomPassword);
    el('pw-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitRoomPassword();
    });

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
        renderSetIconRow();
      }).catch(function (err) {
        alert(err.message || '头像处理失败');
      });
      event.target.value = '';
    });

    el('btn-new-room').addEventListener('click', function () {
      openRoomModal('create', null);
    });

    if (localStorage.getItem(LS.collapsed) === '1' && !isMobile()) {
      el('app').classList.add('collapsed');
    }

    window.addEventListener('resize', function () {
      if (!isMobile()) closeMobileSidebar();
      updatePlaceholder();
      autoResize();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () {
        updatePlaceholder();
        autoResize();
        scrollToBottom(true);
      }, 260);
    });
  }

  // ---------------- 启动 ----------------
  function init() {
    paintIcons();

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
    el('auth-nick').addEventListener('input', renderRegAvatar);

    el('reg-upload-btn').addEventListener('click', function () { el('reg-avatar-file').click(); });
    el('reg-avatar-file').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      fileToAvatar(file).then(function (dataUrl) {
        state.regAvatar = dataUrl;
        renderRegAvatar();
        renderRegIconRow();
      }).catch(function (err) {
        showAuthError(err.message || '头像处理失败');
      });
      event.target.value = '';
    });

    setAuthMode('login');
    fillSavedUsername();

    ensureAdminAccount().then(function () {
      iconAvatarUrl('cat').then(function (url) {
        if (!state.regAvatar) {
          state.regAvatar = url || '';
          renderRegAvatar();
        }
        renderRegIconRow();
      });
      el('auth-user').focus();
    }).catch(function () {
      renderRegIconRow();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
</script>
</body>
</html>
`;

export {
  ChatRoom,
  src_default as default
};

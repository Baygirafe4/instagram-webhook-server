const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Конфиг ──────────────────────────────────────────────────────────────────
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "fastreply_secret";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL = process.env.BASE_URL || "https://instagram-webhook-server-ae6c.onrender.com";

// ─── База бизнесов (JSON файл) ────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "businesses.json");

function loadBusinesses() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({}));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveBusiness(igId, data) {
  const businesses = loadBusinesses();
  businesses[igId] = data;
  fs.writeFileSync(DB_PATH, JSON.stringify(businesses, null, 2));
}

function getBusinessByIgId(igId) {
  const businesses = loadBusinesses();
  return businesses[igId] || null;
}

// ─── Память диалогов ──────────────────────────────────────────────────────────
const conversations = {};

function getConversation(senderId) {
  if (!conversations[senderId]) {
    conversations[senderId] = { messages: [], humanMode: false };
  }
  return conversations[senderId];
}

// ─── Системный промпт (шаблон) ────────────────────────────────────────────────
function buildSystemPrompt(business) {
  return `Ты — вежливый AI-ассистент бизнеса "${business.name}".
Отвечай коротко, по-человечески. Пиши на языке клиента.

ИНФОРМАЦИЯ О БИЗНЕСЕ:
${business.description}

ПРАВИЛА:
1. Если клиент хочет записаться — собери: имя, услугу, дату/время, телефон.
2. Когда собрал ВСЕ данные — напиши красивое резюме заявки клиенту и в конце на новой строке добавь: [ЗАЯВКА_ГОТОВА]
3. Если клиент пишет "хочу с человеком" или "администратор" — ответь что передаёшь и добавь: [НУЖЕН_ЧЕЛОВЕК]
4. Не придумывай данные которых нет выше.
5. Не отвечай на вопросы не связанные с бизнесом.`;
}

// ─── Страница подключения ─────────────────────────────────────────────────────
app.get("/connect", (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FastReply — Подключить Instagram</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 20px; padding: 48px 40px; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 4px 40px rgba(0,0,0,0.08); }
    .logo { font-size: 32px; font-weight: 800; color: #111; margin-bottom: 8px; }
    .logo span { color: #6C47FF; }
    .subtitle { color: #888; font-size: 15px; margin-bottom: 40px; }
    .features { text-align: left; margin-bottom: 36px; }
    .feature { display: flex; align-items: center; gap: 12px; padding: 10px 0; color: #333; font-size: 15px; }
    .feature-icon { font-size: 20px; }
    .btn { display: block; background: linear-gradient(135deg, #6C47FF, #9B59FF); color: white; text-decoration: none; padding: 16px 32px; border-radius: 12px; font-size: 16px; font-weight: 600; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.9; }
    .safe { color: #aaa; font-size: 13px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Fast<span>Reply</span></div>
    <div class="subtitle">AI-ассистент для вашего Instagram</div>
    <div class="features">
      <div class="feature"><span class="feature-icon">🤖</span> AI отвечает клиентам 24/7</div>
      <div class="feature"><span class="feature-icon">📋</span> Собирает заявки автоматически</div>
      <div class="feature"><span class="feature-icon">📱</span> Уведомления в Telegram</div>
      <div class="feature"><span class="feature-icon">🔒</span> Без доступа к паролю</div>
    </div>
    <a href="/auth/instagram" class="btn">Подключить Instagram →</a>
    <div class="safe">🔐 Безопасно через официальный Meta API</div>
  </div>
</body>
</html>`;
  res.send(html);
});

// ─── OAuth: начало авторизации ────────────────────────────────────────────────
app.get("/auth/instagram", (req, res) => {
  const scopes = [
    "instagram_business_basic",
    "instagram_business_manage_messages"
  ].join(",");

  const authUrl = `https://api.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=0&client_id=${APP_ID}&redirect_uri=${BASE_URL}/auth/callback&response_type=code&scope=instagram_business_basic%2Cinstagram_business_manage_messages`;
  res.redirect(authUrl);
});

// ─── OAuth: callback после авторизации ───────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.send(`<h2>❌ Ошибка авторизации</h2><p>${error || "Нет кода"}</p><a href="/connect">Попробовать снова</a>`);
  }

  try {
    // Меняем code на access token
  const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "1598302307924157",
    client_secret: "d58db85080922d0bab48",
    grant_type: "authorization_code",
    redirect_uri: "https://instagram-webhook-server-ae6c.onrender.com/auth/callback",
    code: code.replace("#_", "")
  })
});

    const tokenData = await tokenRes.json();
    console.log("Token response:", tokenData);

    if (!tokenData.access_token) {
      return res.send(`<h2>❌ Ошибка получения токена</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
    }

    const shortToken = tokenData.access_token;
    const igUserId = tokenData.user_id;

    // Получаем long-lived token (60 дней)
    const longTokenRes = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${APP_SECRET}&access_token=${shortToken}`
    );
    const longTokenData = await longTokenRes.json();
    const accessToken = longTokenData.access_token || shortToken;

    // Получаем инфо об аккаунте
    const profileRes = await fetch(
      `https://graph.instagram.com/v21.0/${igUserId}?fields=username,name&access_token=${accessToken}`
    );
    const profile = await profileRes.json();
    console.log("Profile:", profile);

    // Сохраняем бизнес
    saveBusiness(String(igUserId), {
      igId: String(igUserId),
      username: profile.username || "unknown",
      name: profile.name || profile.username || "Бизнес",
      accessToken,
      telegramChatId: null,
      description: `Название: ${profile.name || profile.username}\n(Добавьте описание, цены и услуги через поддержку)`,
      connectedAt: new Date().toISOString()
    });

    console.log(`✅ Новый бизнес подключён: @${profile.username} (ID: ${igUserId})`);

    // Страница успеха
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FastReply — Подключено!</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 20px; padding: 48px 40px; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 4px 40px rgba(0,0,0,0.08); }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h2 { font-size: 24px; margin-bottom: 8px; }
    p { color: #666; margin-bottom: 8px; }
    .username { font-weight: 700; color: #6C47FF; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎉</div>
    <h2>Instagram подключён!</h2>
    <p>Аккаунт <span class="username">@${profile.username}</span> успешно подключён к FastReply.</p>
    <p style="margin-top:16px; color:#aaa; font-size:14px;">Мы настроим бота под ваш бизнес и свяжемся с вами в течение 24 часов.</p>
  </div>
</body>
</html>`);

  } catch (err) {
    console.error("OAuth error:", err);
    res.send(`<h2>❌ Ошибка</h2><pre>${err.message}</pre>`);
  }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("FastReply is running"));

app.get("/api/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/api/webhook", async (req, res) => {
  console.log("Webhook event:", JSON.stringify(req.body, null, 2));

  try {
    if (req.body.object === "instagram") {
      for (const entry of req.body.entry || []) {
        const recipientId = entry.id; // Instagram ID бизнеса

        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const messageText = event.message?.text;

          if (!senderId || !messageText) continue;
          if (event.message?.is_echo) continue;

          // Находим бизнес по ID получателя
          const business = getBusinessByIgId(recipientId) || getBusinessByIgId(senderId);

          if (!business) {
            console.log(`Бизнес не найден для ID: ${recipientId}`);
            continue;
          }

          await handleMessage(senderId, messageText, business);
        }
      }
    }
    return res.status(200).json({ status: "EVENT_RECEIVED" });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).json({ status: "ERROR_HANDLED" });
  }
});

// ─── Главная логика ───────────────────────────────────────────────────────────
async function handleMessage(senderId, text, business) {
  const conv = getConversation(`${business.igId}_${senderId}`);

  if (conv.humanMode) {
    await notifyDirector(`💬 Клиент пишет:\n"${text}"`, senderId, conv, business);
    return;
  }

  conv.messages.push({ role: "user", content: text });
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);

  const aiReply = await askClaude(conv.messages, business);

  if (!aiReply) {
    await sendInstagramMessage(senderId, "Извините, произошла ошибка. Попробуйте позже.", business.accessToken);
    return;
  }

  conv.messages.push({ role: "assistant", content: aiReply });

  console.log("=== Claude reply ===\n", aiReply, "\n===================");

  if (aiReply.includes("[ЗАЯВКА_ГОТОВА]")) {
    console.log(">>> Тег ЗАЯВКА_ГОТОВА найден!");
    const cleanReply = aiReply.replace("[ЗАЯВКА_ГОТОВА]", "").trim();
    await sendInstagramMessage(senderId, cleanReply, business.accessToken);
    await notifyDirector("📅 Новая заявка на запись!", senderId, conv, business);
    return;
  }

  if (aiReply.includes("[НУЖЕН_ЧЕЛОВЕК]")) {
    console.log(">>> Тег НУЖЕН_ЧЕЛОВЕК найден!");
    const cleanReply = aiReply.replace("[НУЖЕН_ЧЕЛОВЕК]", "").trim();
    conv.humanMode = true;
    await sendInstagramMessage(senderId, cleanReply, business.accessToken);
    await notifyDirector("🙋 Клиент хочет поговорить с человеком!", senderId, conv, business);
    return;
  }

  await sendInstagramMessage(senderId, aiReply, business.accessToken);
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function askClaude(messages, business) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: buildSystemPrompt(business),
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) { console.error("Claude error:", data); return null; }
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error("Claude fetch error:", err);
    return null;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function notifyDirector(title, senderId, conv, business) {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = business.telegramChatId || process.env.TELEGRAM_CHAT_ID;

  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.log("Telegram не настроен для бизнеса:", business.name);
    return;
  }

  const history = conv.messages
    .slice(-10)
    .map(m => `${m.role === "user" ? "👤 Клиент" : "🤖 Бот"}: ${m.content}`)
    .join("\n\n");

  const message = `${title}\n\n🏢 Бизнес: ${business.name}\nID клиента: ${senderId}\n\n📝 История:\n${history}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    const data = await res.json();
    console.log("Telegram:", data.ok ? "✅ отправлено" : "❌ " + data.description);
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

// ─── Instagram API ────────────────────────────────────────────────────────────
async function sendInstagramMessage(recipientId, text, accessToken) {
  if (!accessToken) { console.error("Нет access token!"); return; }

  const response = await fetch("https://graph.instagram.com/v21.0/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
  });

  const data = await response.json();
  if (!response.ok) console.error("Instagram error:", data);
  else console.log("Instagram: ✅ сообщение отправлено");
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FastReply server running on port ${PORT}`);
  console.log(`ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "✓" : "✗"}`);
  console.log(`META_APP_ID: ${APP_ID ? "✓" : "✗"}`);
  console.log(`META_APP_SECRET: ${APP_SECRET ? "✓" : "✗"}`);
  const businesses = loadBusinesses();
  console.log(`Подключено бизнесов: ${Object.keys(businesses).length}`);
});

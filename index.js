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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Instagram OAuth данные (AL-IG)
const IG_APP_ID = "1598302307924157";
const IG_APP_SECRET = process.env.IG_APP_SECRET;
const REDIRECT_URI = "https://instagram-webhook-server-ae6c.onrender.com/auth/callback";

// ─── База бизнесов ────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "businesses.json");

function loadBusinesses() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveBusiness(igId, data) {
  const businesses = loadBusinesses();
  businesses[igId] = data;
  fs.writeFileSync(DB_PATH, JSON.stringify(businesses, null, 2));
}

// Предзагрузка artoneli.pl
if (process.env.ARTONELI_TOKEN) {
  const businesses = loadBusinesses();
  if (!businesses["17841476102212879"]) {
    saveBusiness("17841476102212879", {
      igId: "17841476102212879",
      username: "artoneli.pl",
      name: "Artoneli",
      accessToken: process.env.ARTONELI_TOKEN,
      telegramChatId: null,
      description: `Название: BARBERSHOP BARBERSQUAD

⭐ ПОПУЛЯРНЫЕ УСЛУГИ:
✂️ Стрижка + мытьё + укладка — 95 zł (40 мин)
💈 Combo стрижка + борода — 145 zł (1 ч 10 мин)
🆕 Первая стрижка — 85 zł (40 мин)

📋 ВСЕ УСЛУГИ:
- Express Boki (только виски) — 75 zł (30 мин)
- Стрижка + депиляция воском — 100 zł (1 ч)
- Стрижка + маска для лица — 125 zł (1 ч)
- Только контуры — 35 zł (15 мин)
- Стрижка бороды + тонирование — 70 zł (30 мин)
- Моделирование бороды — 75 zł (30 мин)
- Стрижка машинкой — 65 zł (25 мин)
- Стрижка длинных волос — 125 zł (1 ч)
- Укладка волос — 35 zł (15 мин)
- Buzz Cut — 85 zł (30 мин)
- Стрижка + массаж головы + воск — 130 zł (1 ч)

📅 ЗАПИСЬ: https://booksy.com/pl-pl/226901_barbershop-barbersquad_barber-shop_3_warszawa`,
      connectedAt: new Date().toISOString()
    });
  }
}

function getBusinessByIgId(igId) {
  return loadBusinesses()[igId] || null;
}

// ─── Память диалогов ──────────────────────────────────────────────────────────
const conversations = {};

function getConversation(key) {
  if (!conversations[key]) {
    conversations[key] = { messages: [], humanMode: false };
  }
  return conversations[key];
}

// ─── Системный промпт ─────────────────────────────────────────────────────────
function buildSystemPrompt(business, lang = 'польский') {
  const now = new Date();
  const currentDateTime = now.toLocaleString('pl-PL', { 
    timeZone: 'Europe/Warsaw',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  return `Ты — вежливый AI-ассистент бизнеса "${business.name}".
Отвечай коротко, по-человечески.

ЯЗЫК: Отвечай ТОЛЬКО на ${lang}. Это обязательно. Используй ТОЛЬКО буквы того языка на котором отвечаешь. Никогда не смешивай алфавиты.

СЕЙЧАС: ${currentDateTime} (Варшава)

ИНФОРМАЦИЯ О БИЗНЕСЕ:
${business.description}

ПРАВИЛА:
1. Если клиент хочет записаться — задавай ТОЛЬКО ОДИН вопрос за раз. Сначала спроси имя. Когда ответит — спроси услугу. Когда ответит — спроси дату и время. Когда ответит — спроси телефон. Никогда не задавай несколько вопросов сразу.
2. Не принимай запись на уже прошедшее время — вежливо предложи другое.
3. Когда собрал ВСЕ данные — напиши красивое резюме заявки БЕЗ звёздочек, добавь ссылку: https://booksy.com/pl-pl/226901_barbershop-barbersquad_barber-shop_3_warszawa и в конце невидимо для клиента добавь только: [ЗАЯВКА_ГОТОВА]
4. Если клиент пишет "хочу с человеком" или "администратор" — ответь что передаёшь и добавь: [НУЖЕН_ЧЕЛОВЕК]
5. Не придумывай данные которых нет выше.
6. Не отвечай на вопросы не связанные с бизнесом.
7. Каждый новый разговор начинай как будто видишь клиента впервые — не учитывай предыдущие разговоры.
8. НИКОГДА не используй звёздочки ** вокруг текста. Пиши обычным текстом без форматирования.
9. НИКОГДА не используй кириллические буквы когда пишешь на польском или английском. Проверяй каждое слово.`;
}

// ─── OAuth страница подключения ───────────────────────────────────────────────
app.get("/connect", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FastReply — Подключить Instagram</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 20px; padding: 48px 40px; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 4px 40px rgba(0,0,0,0.08); }
    .logo { font-size: 32px; font-weight: 800; color: #111; margin-bottom: 8px; }
    .logo span { color: #6C47FF; }
    .subtitle { color: #888; font-size: 15px; margin-bottom: 40px; }
    .features { text-align: left; margin-bottom: 36px; }
    .feature { display: flex; align-items: center; gap: 12px; padding: 10px 0; color: #333; font-size: 15px; }
    .btn { display: block; background: linear-gradient(135deg, #6C47FF, #9B59FF); color: white; text-decoration: none; padding: 16px 32px; border-radius: 12px; font-size: 16px; font-weight: 600; }
    .safe { color: #aaa; font-size: 13px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Fast<span>Reply</span></div>
    <div class="subtitle">AI-ассистент для вашего Instagram</div>
    <div class="features">
      <div class="feature">🤖 AI отвечает клиентам 24/7</div>
      <div class="feature">📋 Собирает заявки автоматически</div>
      <div class="feature">📱 Уведомления в Telegram</div>
      <div class="feature">🔒 Без доступа к паролю</div>
    </div>
    <a href="/auth/instagram" class="btn">Подключить Instagram →</a>
    <div class="safe">🔐 Безопасно через официальный Meta API</div>
  </div>
</body>
</html>`);
});

// ─── OAuth: начало ────────────────────────────────────────────────────────────
app.get("/auth/instagram", (req, res) => {
  const authUrl = `https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=${IG_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=instagram_business_basic%2Cinstagram_business_manage_messages`;
  res.redirect(authUrl);
});

// ─── OAuth: callback ──────────────────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.send(`<h2>❌ Ошибка авторизации</h2><p>${error || "Нет кода"}</p><a href="/connect">Попробовать снова</a>`);
  }

  // Убираем #_ в конце кода
  const cleanCode = code.split("#")[0];

  try {
    // Меняем code на access token
    const params = new URLSearchParams();
    params.append("client_id", IG_APP_ID);
    params.append("client_secret", IG_APP_SECRET);
    params.append("grant_type", "authorization_code");
    params.append("redirect_uri", REDIRECT_URI);
    params.append("code", cleanCode);

    const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: params
    });

    const tokenData = await tokenRes.json();
    console.log("Token response:", JSON.stringify(tokenData));

    if (!tokenData.access_token) {
      return res.send(`<h2>❌ Ошибка получения токена</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
    }

    const shortToken = tokenData.access_token;
    const igUserId = String(tokenData.user_id);

    // Получаем long-lived token
    // Пропускаем long token - используем short token
const accessToken = shortToken;

// Профиль берём из tokenData (user_id уже есть)
const profile = {
  id: igUserId,
  username: null,
  name: "Бизнес " + igUserId
};
    
    console.log("Profile:", JSON.stringify(profile));

    // Сохраняем бизнес
    saveBusiness(igUserId, {
      igId: igUserId,
      username: profile.username || "unknown",
      name: profile.name || profile.username || "Бизнес",
      accessToken,
      telegramChatId: null,
      description: `Название: ${profile.name || profile.username}\n(Опишите ваш бизнес, цены и услуги)`,
      connectedAt: new Date().toISOString()
    });

    console.log(`✅ Новый бизнес подключён: @${profile.username} (ID: ${igUserId})`);

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>FastReply — Подключено!</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 20px; padding: 48px 40px; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 4px 40px rgba(0,0,0,0.08); }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h2 { font-size: 24px; margin-bottom: 8px; }
    .username { font-weight: 700; color: #6C47FF; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎉</div>
    <h2>Instagram подключён!</h2>
    <p>Аккаунт <span class="username">@${profile.username}</span> успешно подключён к FastReply.</p>
    <p style="margin-top:16px; color:#aaa; font-size:14px;">Мы свяжемся с вами в течение 24 часов для настройки бота.</p>
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
        const recipientId = entry.id;
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const messageText = event.message?.text;
          if (!senderId || !messageText) continue;
          if (event.message?.is_echo) continue;

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
function detectLanguage(text) {
  const russianChars = /[а-яёА-ЯЁ]/;
  const polishChars = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
  const polishWords = /\b(czesc|hej|siema|chce|na|sie|tak|nie|dzien|dobry|witaj|umowic|strzyzenie|fryzjer|chcialbym|chcialabym|zapisac|prosze)\b/i;
  
  if (russianChars.test(text)) return 'русский';
  if (polishChars.test(text) || polishWords.test(text)) return 'польский';
  return 'английский';
}
async function handleMessage(senderId, text, business) {
  const conv = getConversation(`${business.igId}_${senderId}`);

  if (conv.humanMode) {
    await notifyDirector(`💬 Клиент пишет:\n"${text}"`, senderId, conv, business);
    return;
  }

  conv.messages.push({ role: "user", content: text });
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);

  const lang = detectLanguage(conv.messages[0]?.content || text);
const aiReply = await askClaude(conv.messages, business, lang);

  if (!aiReply) {
    await sendInstagramMessage(senderId, "Извините, произошла ошибка. Попробуйте позже.", business.accessToken);
    return;
  }

  conv.messages.push({ role: "assistant", content: aiReply });
  console.log("=== Claude reply ===\n", aiReply, "\n===================");

  if (aiReply.includes("[ЗАЯВКА_ГОТОВА]") || aiReply.includes("[ZAJAVKA_GOTOVA]") || aiReply.includes("[ZAYAVKA_GOTOVA]")) {
    const cleanReply = aiReply.replace(/\[.*?\]/g, "").trim();
    await sendInstagramMessage(senderId, cleanReply, business.accessToken);
    await notifyDirector("📅 Новая заявка на запись!", senderId, conv, business);
    return;
  }

  if (aiReply.includes("[НУЖЕН_ЧЕЛОВЕК]")) {
    const cleanReply = aiReply.replace("[НУЖЕН_ЧЕЛОВЕК]", "").trim();
    conv.humanMode = true;
    await sendInstagramMessage(senderId, cleanReply, business.accessToken);
    await notifyDirector("🙋 Клиент хочет поговорить с человеком!", senderId, conv, business);
    return;
  }

  await sendInstagramMessage(senderId, aiReply, business.accessToken);
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function askClaude(messages, business, lang = 'польский') {
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
        system: buildSystemPrompt(business, lang),
        messages
      })
    });
    const data = await response.json();
    if (!response.ok) { console.error("Claude error:", data); return null; }
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error("Claude error:", err);
    return null;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function notifyDirector(title, senderId, conv, business) {
  const chatId = business.telegramChatId || TELEGRAM_CHAT_ID;
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;

  const history = conv.messages
    .slice(-10)
    .map(m => `${m.role === "user" ? "👤 Клиент" : "🤖 Бот"}: ${m.content}`)
    .join("\n\n");

  const message = `${title}\n\n🏢 ${business.name}\nID: ${senderId}\n\n📝 История:\n${history}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    const data = await res.json();
    console.log("Telegram:", data.ok ? "✅" : "❌ " + data.description);
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

// ─── Instagram API ────────────────────────────────────────────────────────────
async function sendInstagramMessage(recipientId, text, accessToken) {
  if (!accessToken) return;
  const response = await fetch("https://graph.instagram.com/v21.0/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
  });
  const data = await response.json();
  if (!response.ok) console.error("Instagram error:", data);
  else console.log("Instagram: ✅ отправлено");
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FastReply server running on port ${PORT}`);
  console.log(`ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "✓" : "✗"}`);
  console.log(`TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? "✓" : "✗"}`);
  const businesses = loadBusinesses();
  console.log(`Подключено бизнесов: ${Object.keys(businesses).length}`);
});

const express = require("express");
const { MongoClient } = require("mongodb");

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
let db;

async function connectDB() {
  if (!MONGODB_URI) return;
  try {
    const client = new MongoClient(MONGODB_URI, { tls: true, tlsAllowInvalidCertificates: true });
    await client.connect();
    db = client.db("fastreply");
    console.log("MongoDB: ✅ подключено");
  } catch (err) {
    console.error("MongoDB error:", err);
  }
}
connectDB();
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
const menuSent = {};

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
const pendingReschedule = {};

// ─── MongoDB helpers ──────────────────────────────────────────────────────────
async function saveConversation(key, data) {
  if (!db) return;
  await db.collection("conversations").updateOne(
    { key },
    { $set: { key, ...data, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function loadConversation(key) {
  if (!db) return null;
  return await db.collection("conversations").findOne({ key });
}

async function savePendingReschedule(senderId, time) {
  if (!db) return;
  await db.collection("pending").updateOne(
    { senderId },
    { $set: { senderId, time, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function loadPendingReschedule(senderId) {
  if (!db) return null;
  const doc = await db.collection("pending").findOne({ senderId });
  return doc ? doc.time : null;
}

async function deletePendingReschedule(senderId) {
  if (!db) return;
  await db.collection("pending").deleteOne({ senderId });
}

// ─── Внутренний календарь ─────────────────────────────────────────────────────
// ─── Слоты в MongoDB ──────────────────────────────────────────────────────────
async function isSlotTaken(date, time, businessId) {
  if (!db) return false;
  const doc = await db.collection("slots").findOne({ businessId, date, time });
  return !!doc;
}

async function bookSlot(date, time, businessId) {
  if (!db) return;
  await db.collection("slots").updateOne(
    { businessId, date, time },
    { $set: { businessId, date, time, bookedAt: new Date() } },
    { upsert: true }
  );
}

async function freeSlot(date, time, businessId) {
  if (!db) return;
  await db.collection("slots").deleteOne({ businessId, date, time });
}

function getConversation(key) {
  if (!conversations[key]) {
    conversations[key] = { messages: [], humanMode: false };
  }
  return conversations[key];
}

// ─── Системный промпт ─────────────────────────────────────────────────────────
async function buildSystemPrompt(business, lang = 'польский') {
  let bookedInfo = '';
  if (db) {
    const today = new Date();
const slots = await db.collection('slots').find({ businessId: business.igId }).toArray();
const futureSlots = slots.filter(s => {
  if (!s.createdAt) return true;
  return new Date(s.createdAt) > new Date(today.getFullYear(), today.getMonth(), today.getDate());
});
if (futureSlots.length > 0) {
  bookedInfo = '\nЗАНЯТЫЕ СЛОТЫ (никогда не предлагай это время на эту дату):\n' + 
    futureSlots.map(s => `- ${s.date} в ${s.time}`).join('\n');
}
  }
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
КАЛЕНДАРЬ БЛИЖАЙШИХ 14 ДНЕЙ:
${Array.from({length: 14}, (_, i) => {
  const d = new Date(Date.now() + (i+1) * 86400000);
  const label = i === 0 ? 'Завтра' : i === 1 ? 'Послезавтра' : `+${i+1} дней`;
  return `- ${label}: ${d.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', weekday: 'long', day: 'numeric', month: 'long' })}`;
}).join('\n')}
${bookedInfo}

ИНФОРМАЦИЯ О БИЗНЕСЕ:
${business.description}

ПРАВИЛА:
1. Если клиент хочет записаться — задавай ТОЛЬКО ОДИН вопрос за раз. Сначала спроси имя. Когда ответит — спроси услугу. Когда ответит — спроси дату и время. Когда ответит — спроси телефон. Никогда не задавай несколько вопросов сразу. Никогда не переспрашивай и не уточняй то что клиент уже сказал.
2. Не принимай запись на уже прошедшее время — вежливо предложи другое.
3. Когда клиент называет желаемое время — проверь занято ли оно. Если занято — предложи другое. Когда собрал ВСЕ данные (имя, услугу, дату/время, телефон) — напиши резюме заявки БЕЗ вопросов о подтверждении, добавь ссылку: https://booksy.com/pl-pl/226901_barbershop-barbersquad_barber-shop_3_warszawa и в конце добавь: [ЗАЯВКА_ГОТОВА]
4. Если клиент пишет "хочу с человеком" или "администратор" — ответь что передаёшь и добавь: [НУЖЕН_ЧЕЛОВЕК]
5. Не придумывай данные которых нет выше.
6. Не отвечай на вопросы не связанные с бизнесом.
7. Каждый новый разговор начинай как будто видишь клиента впервые — не учитывай предыдущие разговоры.
8. НИКОГДА не используй звёздочки ** вокруг текста. Пиши обычным текстом без форматирования.
9. НИКОГДА не используй кириллические буквы когда пишешь на польском или английском. Проверяй каждое слово.
10. Когда клиент подтверждает новое время барбера — ОБЯЗАТЕЛЬНО напиши резюме заявки и в самом конце на отдельной строке добавь [ЗАЯВКА_ГОТОВА]. Без этой метки заявка не будет зарегистрирована.
11. Если клиент отрицает или говорит что время не подходит — спроси на какое время он хотел бы записаться.
12. Если клиент пишет что не сможет прийти или хочет отменить запись — спроси: "Хотите перенести запись на другое время или отменить совсем?" и жди ответа. Если хочет перенести — спроси на какое время и собери новую заявку. Если отменить — скажи что запись отменена и добавь в конце: [ОТМЕНА_ЗАПИСИ]
`;
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

  // Проверяем ждёт ли подтверждения времени
  if (conv.awaitingTimeConfirm && /^(да|yes|tak|ok|окей|подходит|годится|супер|отлично|хорошо)/i.test(text)) {
    const confirmedTime = conv.awaitingTimeConfirm;
    conv.awaitingTimeConfirm = null;
    // Освобождаем старый слот, бронируем новый
const oldSlotMatch = conv.messages.filter(m => m.role === "assistant").slice(-3)[0]?.content.match(/(\d{1,2}):(\d{2})/);
const dateSlotMatch = conv.messages.filter(m => m.role === "assistant").slice(-1)[0]?.content.match(/(\d{1,2})\s*(июня|июля|мая|апреля|марта|февраля|января|августа|сентября|октября|ноября|декабря)/i);
if (oldSlotMatch && dateSlotMatch) await freeSlot(dateSlotMatch[0], oldSlotMatch[0], business.igId);
if (dateSlotMatch) await bookSlot(dateSlotMatch[0], confirmedTime, business.igId);
conv.completed = true;
    await sendInstagramMessage(senderId, `✅ Отлично! Ваша запись подтверждена на ${confirmedTime}. Ждём вас! 💈`, business.accessToken);
    const pendingDocConfirm = db ? await db.collection("pending").findOne({ senderId }) : null;
const replyToIdConfirm = pendingDocConfirm?.telegramMessageId || null;
await notifyDirector(`✏️ Клиент подтвердил новое время: ${confirmedTime}`, senderId, conv, business, confirmedTime, replyToIdConfirm);
    await deletePendingReschedule(senderId);
    return;
  }

  if (conv.humanMode) {
    await notifyDirector(`💬 Клиент пишет:\n"${text}"`, senderId, conv, business);
    return;
  }

  // Проверяем занятость если клиент называет время
const userTimeMatch = text.match(/(\d{1,2})[:.]\s*(\d{2})/);
if (userTimeMatch && !conv.awaitingTimeConfirm) {
  const userTime = `${userTimeMatch[1]}:${userTimeMatch[2].padStart(2, '0')}`;
  const tz = 'Europe/Warsaw';
  const getDateStr = (daysAhead) => {
    const d = new Date(Date.now() + daysAhead * 86400000);
    return d.toLocaleString('pl-PL', { timeZone: tz, day: 'numeric', month: 'long' });
  };
  const currentDayNum = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' }).toLowerCase();
  const days = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
  const dayNamesRU = { понедельник: 1, вторник: 2, среда: 3, четверг: 4, пятница: 5, суббота: 6, воскресенье: 0 };
  const dayNamesPL = { poniedzialek: 1, wtorek: 2, sroda: 3, czwartek: 4, piatek: 5, sobota: 6, niedziela: 0 };
  const currentNum = days[currentDayNum] ?? 0;

  let checkDate = null;
  if (/сегодня|dzisiaj|today/i.test(text)) {
    checkDate = getDateStr(0);
  } else if (/послезавтра|pojutrze/i.test(text)) {
    checkDate = getDateStr(2);
  } else if (/завтра|jutro|tomorrow/i.test(text)) {
    checkDate = getDateStr(1);
  } else {
    for (const [name, num] of Object.entries({...dayNamesRU, ...dayNamesPL})) {
      if (new RegExp(name, 'i').test(text)) {
        let diff = num - currentNum;
        if (diff <= 0) diff += 7;
        checkDate = getDateStr(diff);
        break;
      }
    }
    if (!checkDate) {
      const dateInText = text.match(/(\d{1,2})\s*(июня|июля|мая|апреля|марта|февраля|января|августа|сентября|октября|ноября|декабря)/i)
        || conv.messages.filter(m => m.role === "assistant").map(m => m.content).join(" ").match(/(\d{1,2})\s*(июня|июля|мая|апреля|марта|февраля|января|августа|сентября|октября|ноября|декабря)/i);
      if (dateInText) checkDate = dateInText[0];
    }
  }

  if (checkDate) {
    const taken = await isSlotTaken(checkDate, userTime, business.igId);
    if (taken) {
      await sendInstagramMessage(senderId, `К сожалению ${userTime} ${checkDate} уже занято 😔 Выберите другое время!`, business.accessToken);
      return;
    }
  }
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

  if (aiReply.includes("[ЗАЯВКА_ГОТОВА]")) {
  if (conv.completed) return;
  conv.completed = true;

  // Сначала проверяем занятость
  const lastBotMsg = conv.messages.filter(m => m.role === "assistant").slice(-1)[0];
  if (lastBotMsg) {
    const timeMatch = lastBotMsg.content.match(/(\d{1,2}):(\d{2})/);
    const dateMatch = lastBotMsg.content.match(/(\d{1,2})\s*(июня|июля|мая|апреля|марта|февраля|января|августа|сентября|октября|ноября|декабря)/i);
    if (timeMatch && dateMatch) {
      const taken = await isSlotTaken(dateMatch[0], timeMatch[0], business.igId);
      if (taken) {
        conv.completed = false;
        await sendInstagramMessage(senderId, `К сожалению ${timeMatch[0]} ${dateMatch[0]} уже занято 😔 Выберите другое время!`, business.accessToken);
        return;
      }
      await bookSlot(dateMatch[0], timeMatch[0], business.igId);
      // Сохраняем заявку для напоминания
const nameMatch = aiReply.match(/Имя[:\s]+([^\n]+)/i);
const serviceMatch = aiReply.match(/Услуга[:\s]+([^\n]+)/i);
      if (db) {
  await db.collection("appointments").insertOne({
  senderId,
  businessId: business.igId,
  accessToken: business.accessToken,
  date: dateMatch[0],
  time: timeMatch[0],
  name: nameMatch ? nameMatch[1]?.trim() || nameMatch[0].replace(/Имя[:\s]*/i, "").trim() : "не указано",
  service: serviceMatch ? serviceMatch[0].replace(/Услуга[:\s]*/i, "").trim() : "не указана",
  telegramMessageId: conv.telegramMessageId || null,
  status: "confirmed",
  createdAt: new Date(),
  reminded: false
});
}
      console.log(`Слот забронирован: ${dateMatch[0]} ${timeMatch[0]}`);
    }
  }

  // Отправляем клиенту
  const cleanReply = aiReply.replace(/\[.*?\]/g, "").trim();
  await sendInstagramMessage(senderId, cleanReply, business.accessToken);

  // Отправляем барберу в Telegram
  const pendingTime = await loadPendingReschedule(senderId);
if (pendingTime) {
  const pendingDoc = db ? await db.collection("pending").findOne({ senderId }) : null;
  const replyToId = pendingDoc?.telegramMessageId || null;
  console.log(`replyToId для ${senderId}:`, replyToId);
  await deletePendingReschedule(senderId);
  await notifyDirector(`✏️ Клиент подтвердил новое время: ${pendingTime}`, senderId, conv, business, pendingTime, replyToId);
} else {
  await notifyDirector("📅 Новая заявка на запись!", senderId, conv, business);
}
  return;
}

  if (aiReply.includes("[НУЖЕН_ЧЕЛОВЕК]")) {
    const cleanReply = aiReply.replace("[НУЖЕН_ЧЕЛОВЕК]", "").trim();
    conv.humanMode = true;
    await sendInstagramMessage(senderId, cleanReply, business.accessToken);
    await notifyDirector("🙋 Клиент хочет поговорить с человеком!", senderId, conv, business);
    return;
  }

  if (aiReply.includes("[ОТМЕНА_ЗАПИСИ]")) {
  const cleanReply = aiReply.replace(/\[.*?\]/g, "").trim();
  await sendInstagramMessage(senderId, cleanReply, business.accessToken);
  if (db) {
    await db.collection("appointments").updateMany(
      { senderId, reminded: false },
      { $set: { cancelled: true } }
    );
  }
  conv.completed = false;
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
        system: await buildSystemPrompt(business, lang),
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
async function notifyDirector(title, senderId, conv, business, overrideTime = null, replyToMessageId = null) {
  const chatId = business.telegramChatId || TELEGRAM_CHAT_ID;
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;

  const history = conv.messages
    .slice(-10)
    .map(m => `${m.role === "user" ? "👤 Клиент" : "🤖 Бот"}: ${m.content}`)
    .join("\n\n");

  const lastMessages = conv.messages.slice(-6);
const clientInfo = lastMessages
  .filter(m => m.role === "user")
  .map(m => m.content)
  .join(", ");

const msgs = conv.messages.filter(m => m.role === "user").map(m => m.content);
const lastBot = conv.messages.filter(m => m.role === "assistant").slice(-1)[0]?.content || "";

const serviceMatch = lastBot.match(/Услуга[:\s]+([^\n]+)/i) || lastBot.match(/Стрижка[^\n]*/i);
const timeMatch = lastBot.match(/Время[:\s]+([^\n]+)/i) || lastBot.match(/\d{1,2}\s*(июня|июля|мая)[^\n]*/i);
const phoneMatch = msgs.join(" ").match(/\+?[\d\s\-]{9,}/);

const service = serviceMatch ? serviceMatch[0].replace(/Услуга[:\s]*/i, "").trim() : "не указана";
const time = overrideTime || (timeMatch ? timeMatch[0].replace(/Время[:\s]*/i, "").trim() : "не указано");
const phone = phoneMatch ? phoneMatch[0].trim() : "не указан";

const nameMatch = lastBot.match(/Имя[:\s]+([^\n]+)/i) || msgs.join(" ").match(/меня зовут\s+(\w+)/i);
const name = nameMatch ? nameMatch[1]?.trim() || nameMatch[0].replace(/Имя[:\s]*/i, "").trim() : "не указано";

const message = `${title}\n\n👤 Имя: ${name}\n✂️ Услуга: ${service}\n🕐 Время: ${time}\n📱 Телефон: ${phone}`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "🕐 Выбрать время", callback_data: `slots_${senderId}` },
        { text: "❌ Отменить", callback_data: `cancel_${senderId}` }
      ],
      [
        { text: "✏️ Своё время", callback_data: `reschedule_${senderId}` },
        { text: "📖 Открыть Booksy", url: "https://booksy.com/pl-pl/226901_barbershop-barbersquad_barber-shop_3_warszawa" }
      ]
    ]
  };

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, reply_markup: keyboard, ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}) })
    });
    const data = await res.json();
    if (data.ok && data.result?.message_id) {
  conv.telegramMessageId = data.result.message_id;
  // Сохраняем в MongoDB
  if (db) {
    await db.collection("pending").updateOne(
      { senderId },
      { $set: { telegramMessageId: data.result.message_id } },
      { upsert: true }
    );
  }
}
    console.log("Telegram:", data.ok ? "✅" : "❌ " + data.description);
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

// ─── Ожидание своего времени от барбера ──────────────────────────────────────
const waitingForCustomTime = {};

// ─── Telegram callback handler ────────────────────────────────────────────────
app.post("/telegram/webhook", async (req, res) => {
  const body = req.body;
  res.sendStatus(200);

  // Обработка кнопок
  if (body.callback_query) {
    const { data, message } = body.callback_query;
    const chatId = message.chat.id;

    const answerCallback = () => fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: body.callback_query.id }) }
    );

   const sendTg = (text, replyToId = null) => fetch(
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
  { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...(replyToId ? { reply_to_message_id: replyToId } : {}) }) }
);

    const businesses = loadBusinesses();
    const business = Object.values(businesses).find(b => 
      (b.telegramChatId || TELEGRAM_CHAT_ID) == chatId
    ) || Object.values(businesses)[0];

   if (data.startsWith("time_")) {
  const parts = data.replace("time_", "").split("_");
  const time = parts[parts.length - 1];
  const senderId = parts.slice(0, -1).join("_");
  await answerCallback();
  await savePendingReschedule(senderId, time);
  const convKey = `${business.igId}_${senderId}`;
const replyId = conversations[convKey]?.telegramMessageId;
await sendTg(`✅ Время ${time} предложено клиенту. Ждём подтверждения.`, replyId);
  await sendInstagramMessage(senderId, `Барбер предлагает вам время ${time} — подходит? 😊`, business.accessToken);
  
  // Сбрасываем разговор чтобы следующее "да" было правильно обработано
  if (conversations[convKey]) {
    conversations[convKey].awaitingTimeConfirm = time;
  }
}

    if (data.startsWith("slots_")) {
      const senderId = data.replace("slots_", "");
      await answerCallback();
      
      const times = [];
      for (let h = 10; h <= 18; h++) {
        times.push(`${h}:00`);
        times.push(`${h}:30`);
      }
      times.push("19:00");

      const rows = [];
      for (let i = 0; i < times.length; i += 4) {
        rows.push(times.slice(i, i + 4).map(t => ({
          text: t,
          callback_data: `time_${senderId}_${t}`
        })));
      }
      rows.push([{ text: "✏️ Написать своё время", callback_data: `reschedule_${senderId}` }]);

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "⏰ Выберите свободный слот:",
          reply_markup: { inline_keyboard: rows }
        })
      });
    }

    if (data.startsWith("confirm_")) {
      const senderId = data.replace("confirm_", "");
      await answerCallback();
      await sendTg("✅ Заявка подтверждена!");
      await sendInstagramMessage(senderId, "✅ Ваша запись подтверждена! Ждём вас 💈", business.accessToken);
    }

    if (data.startsWith("cancel_")) {
  const senderId = data.replace("cancel_", "");
  await answerCallback();
  await sendTg("❌ Заявка отменена. Клиент уведомлён.");
  await sendInstagramMessage(senderId, "К сожалению барбер занят в это время 😔 На какое другое время хотите записаться?", business.accessToken);
}

    if (data.startsWith("reschedule_")) {
      const senderId = data.replace("reschedule_", "");
      await answerCallback();
      waitingForCustomTime[chatId] = senderId;
      await sendTg("✏️ Напишите удобное время (например: завтра в 14:30)");
      await sendInstagramMessage(senderId, "Это время занято 😔 Барбер подберёт другое время — ожидайте!", business.accessToken);
    }
  }

  // Обработка текстового ответа барбера с кастомным временем
  if (body.message && body.message.text) {
    const chatId = body.message.chat.id;
    const text = body.message.text;

    // Команда /меню
console.log(`TG message: chatId=${chatId}, text=${text}`);
if ((text.startsWith("/меню") || text.toLowerCase().startsWith("меню")) && !body.message.from?.is_bot && !menuSent[chatId]) {
  menuSent[chatId] = true;
  setTimeout(() => { delete menuSent[chatId]; }, 3000);
  const parts = text.split(" ");
  const day = parts[1] ? parseInt(parts[1]) : new Date().getDate();
  const now = new Date();
  const monthStr = now.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', month: 'long' });
  const dateKey = `${day} ${monthStr}`;

  const times = [];
  for (let h = 10; h <= 18; h++) {
    times.push(`${h}:00`);
    times.push(`${h}:30`);
  }
  times.push("19:00");

  const businesses = loadBusinesses();
const businessForMenu = Object.values(businesses).find(b => 
  (b.telegramChatId || TELEGRAM_CHAT_ID) == chatId
) || Object.values(businesses)[0];

const appointments = db ? await db.collection("appointments").find({
  businessId: businessForMenu?.igId,
  date: { $regex: String(day) },
  status: { $ne: "cancelled" }
}).toArray() : [];

  let menu = `📅 Расписание на ${dateKey}:\n\n`;
  for (const time of times) {
    const apt = appointments.find(a => a.time === time);
    if (apt) {
      const link = apt.telegramMessageId ? 
        `https://t.me/c/${String(chatId).replace("-100", "")}/${apt.telegramMessageId}` : "";
      menu += `📌 ${time} — ${apt.name || "не указано"} (${apt.service || "не указана"})\n`;
    } else {
      menu += `✅ ${time} — свободно\n`;
    }
  }

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: menu, parse_mode: "Markdown" })
  });
  return;
    }

    if (waitingForCustomTime[chatId]) {
      const senderId = waitingForCustomTime[chatId];
      delete waitingForCustomTime[chatId];

      const businesses = loadBusinesses();
      const business = Object.values(businesses).find(b =>
        (b.telegramChatId || TELEGRAM_CHAT_ID) == chatId
      ) || Object.values(businesses)[0];

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `✅ Время "${text}" отправлено клиенту!` })
      });
      await sendInstagramMessage(senderId, `Барбер предлагает другое время: ${text} — подходит? 😊`, business.accessToken);
    }
  }

});

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

// ─── Напоминания ──────────────────────────────────────────────────────────────
async function sendReminders() {
  if (!db) return;

  const currentHour = parseInt(new Date().toLocaleString('pl-PL', { 
  timeZone: 'Europe/Warsaw', 
  hour: 'numeric', 
  hour12: false 
}));
if (currentHour !== 8) return;
  
  const now = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const tomorrowStr = tomorrow.toLocaleString('pl-PL', { 
    timeZone: 'Europe/Warsaw', 
    day: 'numeric', 
    month: 'long' 
  });
  
  const appointments = await db.collection("appointments").find({ 
    reminded: false,
    date: { $regex: tomorrowStr.split(' ')[0] }
  }).toArray();
  
  for (const apt of appointments) {
    try {
      await sendInstagramMessage(
        apt.senderId, 
        `👋 Привет! Напоминаем что завтра в ${apt.time} ждём вас в барбершопе 💈 Если планы изменились — напишите нам!`,
        apt.accessToken
      );
      await db.collection("appointments").updateOne(
        { _id: apt._id },
        { $set: { reminded: true } }
      );
      console.log(`Напоминание отправлено: ${apt.senderId} на ${apt.date} ${apt.time}`);
    } catch (err) {
      console.error("Ошибка напоминания:", err);
    }
  }
}

// Запускаем каждый час
setInterval(sendReminders, 60 * 60 * 1000);
// И сразу при старте

// Очищаем старые слоты при старте
if (db) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  db.collection('slots').deleteMany({}).then(() => {
    console.log('Старые слоты очищены');
  });
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

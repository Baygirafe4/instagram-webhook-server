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

ПРАЙС-ЛИСТ УСЛУГ (показывай этот список клиенту когда он спрашивает услуги или цены, СОХРАНЯЯ форматирование, эмодзи и номера):

✂️ Наши услуги — выбери номер или напиши название:

⭐ ПОПУЛЯРНОЕ
1️⃣ Стрижка + мытьё + укладка — 95 zł · 40 мин
2️⃣ Combo стрижка + борода — 145 zł · 1 ч 10 мин
3️⃣ Первая стрижка — 85 zł · 40 мин

💈 СТРИЖКИ
4️⃣ Стрижка машинкой — 65 zł · 25 мин
5️⃣ Стрижка длинных волос — 125 zł · 1 ч
6️⃣ Buzz Cut — 85 zł · 30 мин
7️⃣ Express Boki (виски) — 75 zł · 30 мин

🧔 БОРОДА
8️⃣ Моделирование бороды — 75 zł · 30 мин
9️⃣ Борода + тонирование — 70 zł · 30 мин

✨ УХОД
🔟 Стрижка + маска для лица — 125 zł · 1 ч
1️⃣1️⃣ Стрижка + массаж головы + воск — 130 zł · 1 ч
1️⃣2️⃣ Стрижка + депиляция воском — 100 zł · 1 ч

📋 Также: Только контуры — 35 zł · 15 мин | Укладка волос — 35 zł · 15 мин

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

// Находит senderId клиента по id сообщения-заявки в Telegram (когда барбер отвечает reply на заявку)
async function findClientByMessageId(messageId, businessId) {
  if (!db || !messageId) return null;
  // Ищем сначала в pending (свежие заявки), потом в conversations
  const pend = await db.collection("pending").findOne({ telegramMessageId: messageId });
  if (pend?.senderId) return pend.senderId;
  const conv = await db.collection("conversations").findOne({ telegramMessageId: messageId });
  if (conv?.key) {
    // key имеет вид "businessId_senderId" — вытаскиваем senderId
    const prefix = `${businessId}_`;
    if (conv.key.startsWith(prefix)) return conv.key.slice(prefix.length);
  }
  return null;
}

// ─── Внутренний календарь ─────────────────────────────────────────────────────
// ─── Слоты в MongoDB ──────────────────────────────────────────────────────────
async function isSlotTaken(date, time, businessId) {
  if (!db) return false;
  const doc = await db.collection("appointments").findOne({ businessId, date, time, status: { $ne: "cancelled" } });
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

async function getConversation(key) {
  if (!conversations[key]) {
    if (db) {
      const doc = await db.collection("conversations").findOne({ key });
      if (doc) {
        conversations[key] = {
          messages: doc.messages || [],
          humanMode: doc.humanMode || false,
          awaitingTimeConfirm: doc.awaitingTimeConfirm || null,
          completed: doc.completed || false,
          telegramMessageId: doc.telegramMessageId || null
        };
      }
    }
    if (!conversations[key]) {
      conversations[key] = { messages: [], humanMode: false, awaitingTimeConfirm: null, completed: false, telegramMessageId: null };
    }
  }
  return conversations[key];
}

async function persistConv(key) {
  if (!db || !conversations[key]) return;
  const c = conversations[key];
  await db.collection("conversations").updateOne(
    { key },
    { $set: {
        key,
        messages: c.messages,
        humanMode: !!c.humanMode,
        awaitingTimeConfirm: c.awaitingTimeConfirm || null,
        completed: !!c.completed,
        telegramMessageId: c.telegramMessageId || null,
        updatedAt: new Date()
    }},
    { upsert: true }
  );
}

// ─── Системный промпт ─────────────────────────────────────────────────────────
async function buildSystemPrompt(business, lang = 'польский') {
  let bookedInfo = '';
  if (db) {
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
const bookedApts = await db.collection('appointments').find({ businessId: business.igId, date: { $gte: todayIso }, status: { $ne: "cancelled" } }).toArray();
if (bookedApts.length > 0) {
  bookedInfo = '\nЗАНЯТЫЕ СЛОТЫ (никогда не предлагай это время на эту дату):\n' + 
    bookedApts.map(s => `- ${s.date} в ${s.time}`).join('\n');
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
  const iso = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
  return `- ${label}: ${d.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', weekday: 'long', day: 'numeric', month: 'long' })} (ISO: ${iso})`;
}).join('\n')}
${bookedInfo}

ИНФОРМАЦИЯ О БИЗНЕСЕ:
${business.description}

ОБЯЗАТЕЛЬНО О ДАТАХ: Каждый раз когда называешь клиенту КОНКРЕТНУЮ дату (предлагаешь время, подтверждаешь запись, упоминаешь дату записи в любом сообщении) — добавь в самом конце этого сообщения скрытый тег [DATE:YYYY-MM-DD] с этой датой в формате ISO, используя календарь выше. Этот тег система уберёт автоматически, клиент его не увидит. Без этого тега запись не сохранится правильно.

СЛУЖЕБНЫЕ ТЕГИ — КРИТИЧЕСКИ ВАЖНО: Теги [DATE:...], [READY], [CANCEL], [HUMAN] пиши ВСЕГДА латинскими буквами ТОЧНО так как показано, на ЛЮБОМ языке разговора. НИКОГДА не переводи их, не меняй буквы, не пиши кириллицей. Это технические команды, а не слова. Например даже когда отвечаешь на польском или английском — тег всё равно [READY], а не [GOTOWA] или [ZAJAVKA_GOTOWA] или что-то ещё.

ПРАВИЛА:
1. Если клиент хочет записаться — задавай ТОЛЬКО ОДИН вопрос за раз. Сначала спроси имя. Когда ответит — сразу покажи ПОЛНЫЙ ПРАЙС-ЛИСТ УСЛУГ из информации о бизнесе (точь-в-точь, со всеми эмодзи и номерами) и попроси выбрать номер или название. Когда выберет услугу — спроси дату и время. Когда ответит — спроси телефон. Никогда не задавай несколько вопросов сразу. Никогда не переспрашивай и не уточняй то что клиент уже сказал.
2. Не принимай запись на уже прошедшее время — вежливо предложи другое.
3. Когда клиент называет желаемое время — проверь занято ли оно. Если занято — предложи другое. КРИТИЧЕСКИ ВАЖНО: показывай резюме заявки и ставь [READY] ТОЛЬКО когда у тебя УЖЕ ЕСТЬ все 4 данных: имя (реальное имя клиента, а не пусто), услуга, дата+время, телефон. Если имени ещё нет — СНАЧАЛА спроси имя и ДОЖДИСЬ ответа, и только потом показывай резюме. НИКОГДА не пиши в резюме "(не указано)", "(nie podałeś)", "(not provided)" — если данных не хватает, значит рано показывать резюме, сначала спроси недостающее.
4. Если клиент пишет "хочу с человеком" или "администратор" — ответь что передаёшь и добавь: [HUMAN]
5. Не придумывай данные которых нет выше.
6. Не отвечай на вопросы не связанные с бизнесом.
7. Каждый новый разговор начинай как будто видишь клиента впервые — не учитывай предыдущие разговоры.
8. НИКОГДА не используй звёздочки ** вокруг текста. Пиши обычным текстом без форматирования.
9. НИКОГДА не используй кириллические буквы когда пишешь на польском или английском. Проверяй каждое слово. НО служебные теги [READY], [DATE:...], [CANCEL], [HUMAN] это исключение — они всегда латиницей на любом языке.
10. Когда клиент подтверждает новое время барбера — ОБЯЗАТЕЛЬНО напиши резюме заявки и в самом конце на отдельной строке добавь [READY]. Без этой метки заявка не будет зарегистрирована.
11. Если клиент отрицает или говорит что время не подходит — спроси на какое время он хотел бы записаться.
12. Если клиент пишет что не сможет прийти или хочет отменить запись — спроси: "Хотите перенести запись на другое время или отменить совсем?" и жди ответа. Если хочет перенести — спроси на какое время и собери новую заявку. Если отменить — скажи что запись отменена и добавь в конце: [CANCEL]
13. Когда клиент спрашивает услуги, цены, прайс или "что у вас есть" — покажи ПРАЙС-ЛИСТ УСЛУГ точь-в-точь, сохраняя эмодзи, номера и форматирование. На польском/английском переведи текст услуг, но сохрани эмодзи, номера, цены и структуру.
14. Когда клиент отвечает номером услуги (например "5" или "пятое") — определи какая это услуга из прайс-листа и используй её полное название с ценой в заявке. Понимай и номер, и название.
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
function extractIsoDate(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    // Ловим и новый латинский [DATE:...], и старый [ДАТА:...], и любые опечатки регистра
    const match = m.content.match(/\[(?:DATE|ДАТА|DATA)[:\s]*(\d{4}-\d{2}-\d{2})\]/i);
    if (match) return match[1];
  }
  return null;
}

function detectLanguage(text) {
  const russianChars = /[а-яёА-ЯЁ]/;
  const polishChars = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
  const polishWords = /\b(czesc|hej|siema|chce|na|sie|tak|nie|dzien|dobry|witaj|umowic|strzyzenie|fryzjer|chcialbym|chcialabym|zapisac|prosze)\b/i;
  
  if (russianChars.test(text)) return 'русский';
  if (polishChars.test(text) || polishWords.test(text)) return 'польский';
  return 'английский';
}

// Словарь системных фраз на 3 языках. {t} — подстановка времени/значения
const TRANSLATIONS = {
  proposeTime: {
    'русский': 'Барбер предлагает вам время {t} — подходит? 😊',
    'польский': 'Barber proponuje godzinę {t} — pasuje? 😊',
    'английский': 'The barber suggests {t} — does that work for you? 😊'
  },
  proposeOtherTime: {
    'русский': 'Барбер предлагает другое время: {t} — подходит? 😊',
    'польский': 'Barber proponuje inną godzinę: {t} — pasuje? 😊',
    'английский': 'The barber suggests a different time: {t} — does that work? 😊'
  },
  confirmed: {
    'русский': '✅ Отлично! Ваша запись подтверждена на {t}. Ждём вас! 💈',
    'польский': '✅ Świetnie! Twoja rezerwacja na {t} jest potwierdzona. Czekamy! 💈',
    'английский': '✅ Great! Your appointment at {t} is confirmed. See you! 💈'
  },
  confirmedSimple: {
    'русский': '✅ Ваша запись подтверждена! Ждём вас 💈',
    'польский': '✅ Twoja rezerwacja jest potwierdzona! Czekamy 💈',
    'английский': '✅ Your appointment is confirmed! See you 💈'
  },
  barberBusy: {
    'русский': 'К сожалению барбер занят в это время 😔 На какое другое время хотите записаться?',
    'польский': 'Niestety barber jest zajęty o tej porze 😔 Na jaką inną godzinę chcesz się umówić?',
    'английский': 'Unfortunately the barber is busy at that time 😔 What other time would you like?'
  },
  barberWillPick: {
    'русский': 'Это время занято 😔 Барбер подберёт другое время — ожидайте!',
    'польский': 'Ta godzina jest zajęta 😔 Barber dobierze inną — proszę czekać!',
    'английский': 'That time is taken 😔 The barber will pick another — please wait!'
  },
  slotTaken: {
    'русский': 'К сожалению {t} уже занято 😔 Выберите другое время!',
    'польский': 'Niestety {t} jest już zajęte 😔 Wybierz inną godzinę!',
    'английский': 'Unfortunately {t} is already taken 😔 Please choose another time!'
  },
  error: {
    'русский': 'Извините, произошла ошибка. Попробуйте позже.',
    'польский': 'Przepraszam, wystąpił błąd. Spróbuj później.',
    'английский': 'Sorry, an error occurred. Please try again later.'
  },
  alreadyBooked: {
    'русский': 'Привет! Вы уже записаны к нам 😊 Хотите записаться ещё раз или что-то изменить?',
    'польский': 'Cześć! Jesteś już zapisany 😊 Chcesz umówić się jeszcze raz lub coś zmienić?',
    'английский': "Hi! You're already booked with us 😊 Would you like to book again or change something?"
  },
  bookAgain: {
    'русский': 'Отлично, запишем вас ещё раз! 😊 Какую услугу хотите?',
    'польский': 'Świetnie, zapiszemy Cię jeszcze raz! 😊 Jaką usługę wybierasz?',
    'английский': 'Great, let\'s book you again! 😊 Which service would you like?'
  },
  accidental: {
    'русский': 'Ничего страшного! {t}! 😊 Ждём вас на записи! 💈',
    'польский': 'Nic się nie stało! {t}! 😊 Czekamy na Ciebie! 💈',
    'английский': 'No worries! {t}! 😊 See you at your appointment! 💈'
  }
};

// Возвращает фразу на языке клиента (по всем его сообщениям, а не только последнему)
function t(key, conv, value = '') {
  const userMsgs = conv.messages.filter(m => m.role === "user").map(m => m.content);
  // Определяем язык по каждому сообщению; берём преобладающий, но русский/польский имеют приоритет над английским
  let lang = 'английский';
  const joined = userMsgs.join(' ');
  if (/[а-яёА-ЯЁ]/.test(joined)) {
    lang = 'русский';
  } else if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(joined) || /\b(czesc|hej|siema|chce|sie|tak|nie|dzien|dobry|witaj|umowic|strzyzenie|fryzjer|chcialbym|chcialabym|zapisac|prosze|godzina|jutro)\b/i.test(joined)) {
    lang = 'польский';
  } else {
    // Если ни кириллицы ни польского — берём язык последнего осмысленного сообщения
    const lastMeaningful = [...userMsgs].reverse().find(m => m.trim().length > 2 && !/^\+?[\d\s\-:]+$/.test(m.trim())) || joined;
    lang = detectLanguage(lastMeaningful);
  }
  const phrase = (TRANSLATIONS[key] && TRANSLATIONS[key][lang]) || (TRANSLATIONS[key] && TRANSLATIONS[key]['русский']) || '';
  return phrase.replace('{t}', value);
}

async function handleMessage(senderId, text, business) {
  const convKey = `${business.igId}_${senderId}`;
  const conv = await getConversation(convKey);

  // Проверяем ждёт ли подтверждения времени
  if (conv.awaitingTimeConfirm) {
    if (/^(да|yes|tak|ok|okej|okay|окей|подходит|годится|супер|отлично|хорошо|pasuje|zgoda|dobrze|super|świetnie|sure|good|fine)/i.test(text)) {
    const confirmedTime = conv.awaitingTimeConfirm;
    conv.awaitingTimeConfirm = null;
    // Освобождаем старый слот, бронируем новый
if (db) {
  const oldApt = await db.collection("appointments").findOne({ 
    senderId, businessId: business.igId, status: { $ne: "cancelled" }
}, { sort: { createdAt: -1 }
  });
  if (oldApt) {
    await db.collection("slots").deleteOne({ 
      businessId: business.igId, date: oldApt.date, time: oldApt.time 
    });
    await db.collection("appointments").updateOne(
      { _id: oldApt._id },
      { $set: { status: "cancelled" } }
    );
  }
}
const isoDate431 = extractIsoDate(conv.messages);
if (isoDate431) await bookSlot(isoDate431, confirmedTime, business.igId);
    if (isoDate431 && db) {
  const nameM = conv.messages.filter(m => m.role === "assistant").map(m => m.content).join(" ").match(/(?:Имя|Imię|Name)[:\s]+([^\n]+)/i);
  const serviceM = conv.messages.filter(m => m.role === "assistant").map(m => m.content).join(" ").match(/(?:Услуга|Usługa|Service)[:\s]+([^\n]+)/i);
  await db.collection("appointments").insertOne({
    senderId,
    businessId: business.igId,
    accessToken: business.accessToken,
    date: isoDate431,
    time: confirmedTime,
    name: nameM ? nameM[1]?.trim() : "не указано",
    service: serviceM ? serviceM[1]?.trim() : "не указана",
    telegramMessageId: conv.telegramMessageId || null,
    status: "confirmed",
    createdAt: new Date(),
    reminded: false
  });
}
conv.completed = true;
    await persistConv(convKey);
    await sendInstagramMessage(senderId, t('confirmed', conv, confirmedTime), business.accessToken);
    const pendingDocConfirm = db ? await db.collection("pending").findOne({ senderId }) : null;
const replyToIdConfirm = pendingDocConfirm?.telegramMessageId || null;
await notifyDirector(`✏️ Клиент подтвердил новое время: ${confirmedTime}`, senderId, conv, business, confirmedTime, replyToIdConfirm);
    await deletePendingReschedule(senderId);
    return;
    } else {
      // Клиент отказался от предложенного времени — сбрасываем флаги
      // НЕ удаляем pendingReschedule — он нужен чтобы знать что это перенос а не новая запись
      conv.awaitingTimeConfirm = null;
      conv.completed = false;
      conv.isRescheduling = true; // флаг что клиент сам предлагает время после отказа
      await persistConv(convKey);
    }
  }

  if (conv.humanMode) {
    await notifyDirector(`💬 Клиент пишет:\n"${text}"`, senderId, conv, business);
    return;
  }

  // Клиент уже записан — обрабатываем повторное обращение
  if (conv.completed) {
    // Если дата записи уже прошла — сбрасываем автоматически
    const lastApt = db ? await db.collection("appointments").findOne(
      { senderId, businessId: business.igId, status: { $ne: "cancelled" } },
      { sort: { createdAt: -1 } }
    ) : null;
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
    if (!lastApt || lastApt.date < todayIso) {
      conv.messages = [];
      conv.completed = false;
      conv.humanMode = false;
      conv.awaitingTimeConfirm = null;
      await persistConv(convKey);
      // Продолжаем как обычно — клиент может записаться снова
    } else {
      // Запись ещё впереди — разбираем что написал клиент
      const lowerText = text.toLowerCase();
      const isAccidental = /случайн|ошибся|ошиблась|не туда|wrong chat|pomyłka|przepraszam|nie to/i.test(lowerText);
      const wantsCancel = /отмен|cancel|anuluj|не приду|не смогу|отказ/i.test(lowerText);
      const wantsNewBooking = /снова|ещё раз|еще раз|записаться|хочу запис|другой|again|book|znowu|jeszcze raz|chc[ęe]|^да$|^yes$|^tak$/i.test(lowerText);

      if (isAccidental) {
        // Случайное сообщение — прощаемся с учётом времени и языка
        const hour = parseInt(new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Warsaw', hour: 'numeric', hour12: false }));
        const joinedU = conv.messages.filter(m => m.role === "user").map(m => m.content).join(' ');
        let lang = 'английский';
        if (/[а-яёА-ЯЁ]/.test(joinedU)) lang = 'русский';
        else if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(joinedU) || /\b(czesc|hej|tak|nie|dzien|jutro|godzina|prosze)\b/i.test(joinedU)) lang = 'польский';
        const greetings = {
          'русский': hour < 12 ? 'Доброго утра' : hour < 18 ? 'Приятного дня' : 'Приятного вечера',
          'польский': hour < 12 ? 'Miłego poranka' : hour < 18 ? 'Miłego dnia' : 'Miłego wieczoru',
          'английский': hour < 12 ? 'Have a good morning' : hour < 18 ? 'Have a nice day' : 'Have a nice evening'
        };
        await sendInstagramMessage(senderId, t('accidental', conv, greetings[lang]), business.accessToken);
        return;
      } else if (wantsCancel) {
        conv.completed = false;
        await persistConv(convKey);
        // Продолжаем — ИИ обработает отмену через [ОТМЕНА_ЗАПИСИ]
      } else if (wantsNewBooking) {
        // Сохраняем старую запись чтобы потом показать барберу что это перезапись
        const oldAptForRebook = db ? await db.collection("appointments").findOne(
          { senderId, businessId: business.igId, status: { $ne: "cancelled" } },
          { sort: { createdAt: -1 } }
        ) : null;
        // Сбрасываем диалог и начинаем как в первый раз
        const botGreeting = t('bookAgain', conv);
        conv.messages = [{ role: "assistant", content: botGreeting }];
        conv.completed = false;
        conv.humanMode = false;
        conv.awaitingTimeConfirm = null;
        conv.prevApt = oldAptForRebook ? { date: oldAptForRebook.date, time: oldAptForRebook.time } : null;
        conv.isRebooking = true;
        await persistConv(convKey);
        await sendInstagramMessage(senderId, botGreeting, business.accessToken);
        return;
      } else {
        // Непонятное сообщение — напоминаем что записан, но естественно
        const hour = parseInt(new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Warsaw', hour: 'numeric', hour12: false }));
        const greeting = hour < 12 ? 'утра' : hour < 18 ? 'дня' : 'вечера';
        await sendInstagramMessage(
          senderId,
          t('alreadyBooked', conv),
          business.accessToken
        );
        return;
      }
    }
  }

  // Проверяем занятость если клиент называет время
const userTimeMatch = text.match(/(\d{1,2})[:.]\s*(\d{2})/);
if (userTimeMatch && !conv.awaitingTimeConfirm) {
  const userTime = `${userTimeMatch[1]}:${userTimeMatch[2].padStart(2, '0')}`;
  const tz = 'Europe/Warsaw';
  const getDateStr = (daysAhead) => {
    const d = new Date(Date.now() + daysAhead * 86400000);
    return d.toLocaleDateString('en-CA', { timeZone: tz });
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
    for (const [name, num] of Object.entries({...dayNamesRU, ...dayNamesPL, ...days})) {
      if (new RegExp(name, 'i').test(text)) {
        let diff = num - currentNum;
        if (diff <= 0) diff += 7;
        checkDate = getDateStr(diff);
        break;
      }
    }
    if (!checkDate) {
      checkDate = extractIsoDate(conv.messages);
    }
  }

  if (checkDate) {
    const taken = await isSlotTaken(checkDate, userTime, business.igId);
    if (taken) {
      await sendInstagramMessage(senderId, t('slotTaken', conv, `${userTime} ${checkDate}`), business.accessToken);
      return;
    }
  }
}

  conv.messages.push({ role: "user", content: text });
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);

  const lang = detectLanguage(conv.messages[0]?.content || text);
const aiReply = await askClaude(conv.messages, business, lang);

  if (!aiReply) {
    await sendInstagramMessage(senderId, t('error', conv), business.accessToken);
    return;
  }

  conv.messages.push({ role: "assistant", content: aiReply });
  console.log("=== Claude reply ===\n", aiReply, "\n===================");

  if (/\[READY\]/i.test(aiReply) || /\[ЗАЯВКА.ГОТОВ/i.test(aiReply) || /\[ZAJAVKA|\[ZAYAVKA|\[GOTOWA|\[GOTOVA/i.test(aiReply)) {
  if (conv.completed) return;

  // Защита: если имя не собрано (пустое или placeholder) — не создаём заявку, просим имя
  const nameCheck = aiReply.match(/(?:Имя|Imię|Name)[:\s]+([^\n]+)/i);
  const nameVal = nameCheck ? nameCheck[1].trim() : "";
  const namePlaceholder = /не указан|nie poda|not provided|—|отсутству|brak|\(.*\)/i.test(nameVal) || nameVal.length < 2;
  if (namePlaceholder) {
    // Убираем метку и резюме, просим только имя на языке клиента
    const joinedU = conv.messages.filter(m => m.role === "user").map(m => m.content).join(' ');
    let askLang = 'английский';
    if (/[а-яёА-ЯЁ]/.test(joinedU)) askLang = 'русский';
    else if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(joinedU) || /\b(czesc|tak|nie|jutro|godzina)\b/i.test(joinedU)) askLang = 'польский';
    const askName = { 'русский': 'Как вас зовут? 😊', 'польский': 'Jak masz na imię? 😊', 'английский': "What's your name? 😊" }[askLang];
    await sendInstagramMessage(senderId, askName, business.accessToken);
    return;
  }

  conv.completed = true;

  // Сначала проверяем занятость
  const lastBotMsg = conv.messages.filter(m => m.role === "assistant").slice(-1)[0];
  if (lastBotMsg) {
    const timeMatch = lastBotMsg.content.match(/(\d{1,2}):(\d{2})/);
    const isoDate = extractIsoDate(conv.messages);
    if (timeMatch && isoDate) {
      const taken = await isSlotTaken(isoDate, timeMatch[0], business.igId);
      if (taken) {
        conv.completed = false;
        await persistConv(convKey);
        await sendInstagramMessage(senderId, t('slotTaken', conv, timeMatch[0]), business.accessToken);
        return;
      }

      // Удаляем старые слоты этого клиента на эту дату
if (db) {
  const oldApt = await db.collection("appointments").findOne({
    senderId, businessId: business.igId, status: { $ne: "cancelled" }
  }, { sort: { createdAt: -1 } });
  if (oldApt) {
    await db.collection("slots").deleteOne({ 
      businessId: business.igId, date: oldApt.date, time: oldApt.time 
    });
    await db.collection("appointments").updateOne(
      { _id: oldApt._id },
      { $set: { status: "cancelled" } }
    );
  }
}
      
      await bookSlot(isoDate, timeMatch[0], business.igId);
      // Сохраняем заявку для напоминания
const nameMatch = aiReply.match(/(?:Имя|Imię|Name)[:\s]+([^\n]+)/i);
const serviceMatch = aiReply.match(/(?:Услуга|Usługa|Service)[:\s]+([^\n]+)/i);
      if (db) {
  await db.collection("appointments").insertOne({
  senderId,
  businessId: business.igId,
  accessToken: business.accessToken,
  date: isoDate,
  time: timeMatch[0],
  name: nameMatch ? nameMatch[1]?.trim() : "не указано",
  service: serviceMatch ? serviceMatch[1]?.trim() : "не указана",
  telegramMessageId: conv.telegramMessageId || null,
  status: "confirmed",
  createdAt: new Date(),
  reminded: false
});
}
      console.log(`Слот забронирован: ${isoDate} ${timeMatch[0]}`);
    }
  }

  // Отправляем клиенту
  const cleanReply = aiReply.replace(/\[.*?\]/g, "").trim();
  await sendInstagramMessage(senderId, cleanReply, business.accessToken);

  // Отправляем барберу в Telegram
  const pendingTime = await loadPendingReschedule(senderId);
if (pendingTime && !conv.isRescheduling) {
  // Клиент согласился с временем барбера
  const pendingDoc = db ? await db.collection("pending").findOne({ senderId }) : null;
  const replyToId = pendingDoc?.telegramMessageId || null;
  console.log(`replyToId для ${senderId}:`, replyToId);
  await deletePendingReschedule(senderId);
  await notifyDirector(`✏️ Клиент подтвердил новое время: ${pendingTime}`, senderId, conv, business, pendingTime, replyToId);
} else if (conv.isRescheduling || pendingTime) {
  // Клиент отказался от времени барбера и предложил своё
  conv.isRescheduling = false;
  await deletePendingReschedule(senderId);
  await notifyDirector(`✏️ Клиент предложил своё время`, senderId, conv, business);
} else if (conv.isRebooking && conv.prevApt) {
  // Клиент перезаписался — показываем старую и новую запись
  const prevInfo = `${conv.prevApt.date} в ${conv.prevApt.time}`;
  conv.isRebooking = false;
  conv.prevApt = null;
  await notifyDirector(`🔄 Клиент перезаписался!\n\n❌ Старая запись: ${prevInfo} — отменена`, senderId, conv, business);
} else {
  await notifyDirector("📅 Новая заявка на запись!", senderId, conv, business);
}
  await persistConv(convKey);
  return;
}

  if (/\[HUMAN\]/i.test(aiReply) || aiReply.includes("[НУЖЕН_ЧЕЛОВЕК]")) {
    const cleanReply = aiReply.replace(/\[.*?\]/g, "").trim();
    conv.humanMode = true;
    await persistConv(convKey);
    await sendInstagramMessage(senderId, cleanReply, business.accessToken);
    await notifyDirector("🙋 Клиент хочет поговорить с человеком!", senderId, conv, business);
    return;
  }

  if (/\[CANCEL\]/i.test(aiReply) || aiReply.includes("[ОТМЕНА_ЗАПИСИ]")) {
  const cleanReply = aiReply.replace(/\[.*?\]/g, "").trim();
  await sendInstagramMessage(senderId, cleanReply, business.accessToken);

  // Находим запись чтобы показать барберу детали отмены
  const cancelledApt = db ? await db.collection("appointments").findOne(
    { senderId, status: { $ne: "cancelled" } },
    { sort: { createdAt: -1 } }
  ) : null;

  if (db) {
    await db.collection("appointments").updateMany(
      { senderId, status: { $ne: "cancelled" } },
      { $set: { status: "cancelled" } }
    );
    if (cancelledApt) {
      await db.collection("slots").deleteOne({
        businessId: business.igId, date: cancelledApt.date, time: cancelledApt.time
      });
    }
  }

  // Уведомляем барбера об отмене
  const cancelName = cancelledApt?.name || "Клиент";
  const cancelTime = cancelledApt ? `${cancelledApt.date} в ${cancelledApt.time}` : "неизвестное время";
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: `❌ Отмена записи!\n\n👤 Имя: ${cancelName}\n🕐 Время: ${cancelTime}\n\nКлиент отменил запись.`
    })
  });

  conv.completed = false;
  await persistConv(convKey);
  return;
}

  await persistConv(convKey);
  // Убираем ЛЮБЫЕ служебные теги в квадратных скобках (на любом языке) перед отправкой клиенту
  const finalReply = aiReply.replace(/\[[^\]]*\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  await sendInstagramMessage(senderId, finalReply, business.accessToken);
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

// Многоязычное извлечение (русский / польский / английский)
const serviceMatch = lastBot.match(/(?:Услуга|Usługa|Service)[:\s]+([^\n]+)/i)
  || lastBot.match(/(?:Стрижк|Strzyż|Combo|Buzz|Express)[^\n]*/i);
const timeMatch = lastBot.match(/(?:Время|Data i godzina|Godzina|Date and time|Time|Data)[:\s]+([^\n]+)/i)
  || lastBot.match(/\d{1,2}:\d{2}/);
const phoneMatch = msgs.join(" ").match(/\+?[\d\s\-]{9,}/);

const service = serviceMatch
  ? (serviceMatch[1] ? serviceMatch[1].trim() : serviceMatch[0].replace(/(?:Услуга|Usługa|Service)[:\s]*/i, "").trim())
  : "не указана";
const time = overrideTime
  ? overrideTime
  : (timeMatch ? (timeMatch[1] ? timeMatch[1].trim() : timeMatch[0].replace(/(?:Время|Data i godzina|Godzina|Date and time|Time|Data)[:\s]*/i, "").trim()) : "не указано");
const phone = phoneMatch ? phoneMatch[0].trim() : "не указан";

const nameMatch = lastBot.match(/(?:Имя|Imię|Name)[:\s]+([^\n]+)/i)
  || msgs.join(" ").match(/(?:меня зовут|nazywam się|my name is|jestem)\s+(\w+)/i);
const name = nameMatch ? (nameMatch[1] ? nameMatch[1].trim() : nameMatch[0].replace(/(?:Имя|Imię|Name)[:\s]*/i, "").trim()) : "не указано";

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
  const convKey = `${business.igId}_${senderId}`;
  await persistConv(convKey);
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
const convForLang = await getConversation(convKey);
const replyId = conversations[convKey]?.telegramMessageId;
await sendTg(`✅ Время ${time} предложено клиенту. Ждём подтверждения.`, replyId);
  await sendInstagramMessage(senderId, t('proposeTime', convForLang, time), business.accessToken);
  
  // Сбрасываем разговор чтобы следующее "да" было правильно обработано
  if (!conversations[convKey]) {
    conversations[convKey] = { messages: [], humanMode: false, awaitingTimeConfirm: null, completed: false, telegramMessageId: null };
  }
  conversations[convKey].awaitingTimeConfirm = time;
  await persistConv(convKey);
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
      const convC = await getConversation(`${business.igId}_${senderId}`);
      await sendInstagramMessage(senderId, t('confirmedSimple', convC), business.accessToken);
    }

    if (data.startsWith("cancel_")) {
  const senderId = data.replace("cancel_", "");
  await answerCallback();
  await sendTg("❌ Заявка отменена. Клиент уведомлён.");
  const convCancel = await getConversation(`${business.igId}_${senderId}`);
  await sendInstagramMessage(senderId, t('barberBusy', convCancel), business.accessToken);
}

    if (data.startsWith("reschedule_")) {
      const senderId = data.replace("reschedule_", "");
      await answerCallback();
      waitingForCustomTime[chatId] = senderId;
      await sendTg("✏️ Напишите удобное время (например: завтра в 14:30)");
      const convR = await getConversation(`${business.igId}_${senderId}`);
      await sendInstagramMessage(senderId, t('barberWillPick', convR), business.accessToken);
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
  let menuMonth = now.getMonth();
  let menuYear = now.getFullYear();
  if (day < now.getDate()) menuMonth += 1; // запрошенный день уже прошёл в этом месяце — значит имели в виду следующий
  if (menuMonth > 11) { menuMonth = 0; menuYear += 1; }
  const targetIso = `${menuYear}-${String(menuMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

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
  date: targetIso,
  status: { $ne: "cancelled" }
}).toArray() : [];

  let menu = `📅 Расписание на ${dateKey}:\n\n`;
  for (const time of times) {
    const apt = appointments.find(a => a.time === time);
    if (apt) {
      menu += `📌 ${time} — ${apt.name || "не указано"} (${apt.service || "не указана"})\n`;
    } else {
      menu += `✅ ${time} — свободно\n`;
    }
  }

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: menu })
  });
  return;
    }

    // Определяем клиента: сначала по reply на заявку (надёжно), потом по waitingForCustomTime
    const businessesForReply = loadBusinesses();
    const businessReply = Object.values(businessesForReply).find(b =>
      (b.telegramChatId || TELEGRAM_CHAT_ID) == chatId
    ) || Object.values(businessesForReply)[0];
    const replyToMsgId = body.message.reply_to_message?.message_id;
    let customSenderId = null;
    if (replyToMsgId) {
      customSenderId = await findClientByMessageId(replyToMsgId, businessReply?.igId);
    }
    if (!customSenderId && waitingForCustomTime[chatId]) {
      customSenderId = waitingForCustomTime[chatId];
    }

    if (customSenderId && !text.toLowerCase().startsWith("меню") && !text.startsWith("/")) {
      const senderId = customSenderId;
      delete waitingForCustomTime[chatId];

      const business = businessReply;

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `✅ Время "${text}" отправлено клиенту!` })
      });
      await savePendingReschedule(senderId, text);
      const convCustom = await getConversation(`${business.igId}_${senderId}`);
      await sendInstagramMessage(senderId, t('proposeOtherTime', convCustom, text), business.accessToken);
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
  
  const tomorrow = new Date(Date.now() + 86400000);
  const tomorrowIso = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
  
  const appointments = await db.collection("appointments").find({ 
    reminded: false,
    date: tomorrowIso
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

// Очищаем только прошедшие слоты при старте (будущие записи не трогаем!)
if (db) {
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
  db.collection('slots').deleteMany({ date: { $lt: todayIso } }).then(() => {
    console.log('Прошедшие слоты очищены');
  });
  // Чистим диалоги старше 14 дней
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  db.collection('conversations').deleteMany({ updatedAt: { $lt: cutoff } }).then(() => {
    console.log('Старые диалоги очищены');
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

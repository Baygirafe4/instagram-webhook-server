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
  if (!businesses["17841426017477731"]) {
    saveBusiness("17841426017477731", {
      igId: "17841426017477731",
      username: "la.cosmetics",
      name: "la.cosmetics",
      accessToken: process.env.ARTONELI_TOKEN,
      telegramChatId: "7027787839",
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

// ─── Включение/выключение бота (А: для всего бизнеса) ─────────────────────────
const botEnabledCache = {};

async function isBotEnabled(businessId) {
  if (!db) return true;
  if (botEnabledCache[businessId] !== undefined) return botEnabledCache[businessId];
  const doc = await db.collection("settings").findOne({ key: `botEnabled_${businessId}` });
  const enabled = doc ? doc.value !== false : true; // по умолчанию включён
  botEnabledCache[businessId] = enabled;
  return enabled;
}

async function setBotEnabled(businessId, enabled) {
  botEnabledCache[businessId] = enabled;
  if (!db) return;
  await db.collection("settings").updateOne(
    { key: `botEnabled_${businessId}` },
    { $set: { key: `botEnabled_${businessId}`, value: enabled, updatedAt: new Date() } },
    { upsert: true }
  );
}

// Связь telegram-сообщение → клиент (чтобы reply на любое сообщение нашёл клиента)
async function saveMessageLink(messageId, senderId, businessId) {
  if (!db || !messageId) return;
  await db.collection("msglinks").updateOne(
    { messageId },
    { $set: { messageId, senderId, businessId, createdAt: new Date() } },
    { upsert: true }
  );
}

// Находит senderId клиента по id сообщения-заявки в Telegram (когда барбер отвечает reply на заявку)
async function findClientByMessageId(messageId, businessId) {
  if (!db || !messageId) return null;
  // Сначала прямая связь (любое пересланное сообщение)
  const link = await db.collection("msglinks").findOne({ messageId });
  if (link?.senderId) return link.senderId;
  // Потом pending (свежие заявки)
  const pend = await db.collection("pending").findOne({ telegramMessageId: messageId });
  if (pend?.senderId) return pend.senderId;
  const conv = await db.collection("conversations").findOne({ telegramMessageId: messageId });
  if (conv?.key) {
    const prefix = `${businessId}_`;
    if (conv.key.startsWith(prefix)) return conv.key.slice(prefix.length);
  }
  return null;
}

// ─── Внутренний календарь ─────────────────────────────────────────────────────
// ─── Слоты в MongoDB ──────────────────────────────────────────────────────────
async function isSlotTaken(date, time, businessId, excludeSenderId = null) {
  if (!db) return false;
  const query = { businessId, date, time, status: { $ne: "cancelled" } };
  // При переносе не считаем занятой собственную запись клиента
  if (excludeSenderId) query.senderId = { $ne: excludeSenderId };
  const doc = await db.collection("appointments").findOne(query);
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
          manualMode: doc.manualMode || false,
          awaitingTimeConfirm: doc.awaitingTimeConfirm || null,
          completed: doc.completed || false,
          telegramMessageId: doc.telegramMessageId || null
        };
      }
    }
    if (!conversations[key]) {
      conversations[key] = { messages: [], humanMode: false, manualMode: false, awaitingTimeConfirm: null, completed: false, telegramMessageId: null };
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
        manualMode: !!c.manualMode,
        awaitingTimeConfirm: c.awaitingTimeConfirm || null,
        completed: !!c.completed,
        telegramMessageId: c.telegramMessageId || null,
        updatedAt: new Date()
    }},
    { upsert: true }
  );
}

// ─── Системный промпт ─────────────────────────────────────────────────────────
async function buildSystemPrompt(business, lang = 'польский', excludeSenderId = null) {
  let bookedInfo = '';
  if (db) {
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
const bookedQuery = { businessId: business.igId, date: { $gte: todayIso }, status: { $ne: "cancelled" } };
// При переносе не показываем ИИ собственную запись клиента как занятую
if (excludeSenderId) bookedQuery.senderId = { $ne: excludeSenderId };
const bookedApts = await db.collection('appointments').find(bookedQuery).toArray();
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
СЕГОДНЯШНЯЯ ДАТА (точка отсчёта): ${new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' })}

⚠️ КРИТИЧЕСКОЕ ПРАВИЛО О ДАТАХ: Слова "сегодня", "завтра", "послезавтра", "через неделю" ВСЕГДА считаются от СЕГОДНЯШНЕЙ даты (указана выше), а НЕ от даты существующей записи клиента и НЕ от какой-либо другой даты. Даже если у клиента уже есть запись на другой день — "завтра" всё равно означает день после СЕГОДНЯ. Бери даты ТОЛЬКО из календаря ниже, никогда не вычисляй их сам.

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
2. Правило о прошедшем времени: время может быть "уже прошло" ТОЛЬКО если клиент просит записаться на СЕГОДНЯ и названный час уже наступил. Если клиент говорит "завтра", "послезавтра" или называет любой будущий день — время НИКОГДА не может быть прошедшим, даже если этот час меньше текущего. Например если сейчас 15:46, а клиент просит "завтра на 10:00" — это нормально, 10:00 завтра ещё не наступило, принимай запись. НЕ говори что "завтра 10:00 уже прошло" — это ошибка.
3. Когда клиент называет желаемое время — проверь занято ли оно. Если занято — предложи другое. КРИТИЧЕСКИ ВАЖНО: показывай резюме заявки и ставь [READY] ТОЛЬКО когда у тебя УЖЕ ЕСТЬ все 4 данных: имя (реальное имя клиента, а не пусто), услуга, дата+время, телефон. Если имени ещё нет — СНАЧАЛА спроси имя и ДОЖДИСЬ ответа, и только потом показывай резюме. НИКОГДА не пиши в резюме "(не указано)", "(nie podałeś)", "(not provided)" — если данных не хватает, значит рано показывать резюме, сначала спроси недостающее. КОГДА показываешь резюме заявки — НЕ задавай вопросов типа "Всё верно?", "Wszystko się zgadza?", "Is everything correct?". Просто покажи резюме и поставь [READY] в конце. Резюме = финал, никаких вопросов после него.
3a. ВАЖНО про занятость: считай время ЗАНЯТЫМ только если оно ЯВНО есть в списке "ЗАНЯТЫЕ СЛОТЫ" выше. Если этого времени НЕТ в списке занятых — оно СВОБОДНО, принимай запись. НИКОГДА не выдумывай что время занято если его нет в списке. Если список занятых пуст — значит всё время свободно.
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
15. ОПОЗДАНИЯ: Если клиент пишет что опаздывает или задерживается — вежливо ответь что передашь эту информацию мастеру, и добавь в конце: [HUMAN]. Не решай сам можно ли опоздать и на сколько — это решает мастер.
16. ОТМЕНА: Если клиент отменяет запись — вежливо подтверди отмену без осуждения, поблагодари что предупредил, и добавь [CANCEL]. Не проси объяснять причину, не уговаривай остаться.
17. ЧЕГО НЕ ДЕЛАЙ САМ: не придумывай и не обещай скидки, акции, бонусы. Не называй цен которых нет в прайс-листе. Не давай медицинских или косметических советов (про кожу, волосы, аллергии, средства). Не отвечай на личные вопросы о мастерах. Не переноси и не отменяй записи ДРУГИХ клиентов. Не гарантируй конкретного мастера если тебя об этом не просили подтвердить.
18. ПЕРЕДАВАЙ ЧЕЛОВЕКУ (добавляй [HUMAN]) когда: клиент просит скидку или индивидуальные условия; жалуется или недоволен; задаёт сложный вопрос об услуге на который нет ответа в прайсе; конфликтная или необычная ситуация; клиент прямо просит позвать человека/администратора; вопрос про здоровье, аллергию, противопоказания.
19. КОНТЕКСТ ЗАПИСИ: Если в диалоге есть сообщение начинающееся с "[КОНТЕКСТ ДЛЯ ТЕБЯ" — это служебная информация о существующей записи клиента. НИКОГДА не показывай её клиенту и не упоминай. Используй эти данные (имя, услуга, дата, время, телефон) как УЖЕ ИЗВЕСТНЫЕ — не переспрашивай их. Спрашивай только то что клиент хочет изменить. Когда получишь изменение — сразу покажи ПОЛНОЕ резюме заявки (со всеми данными из контекста плюс изменённое) и поставь [READY].
20. НЕОДНОЗНАЧНЫЕ ДАТЫ И ВРЕМЯ: Если клиент пишет дату или время в непонятном или двусмысленном виде — НЕ УГАДЫВАЙ, а вежливо переспроси одним коротким вопросом с вариантами. Примеры двусмысленности: "на 12 12" (это 12 декабря? или 12-го числа в 12:00?), "12.12" (дата или время?), "на 5" (5 число? 5 часов? утра или вечера?), "в 7" (7 утра или 7 вечера?), "на выходных" (суббота или воскресенье?), "на следующей неделе" (какой день?). Пример уточнения: "Уточните пожалуйста — вы имеете в виду 12 декабря или 12-е число в 12:00? 😊". Лучше переспросить один раз, чем записать неправильно. НО: если дата и время понятны однозначно (например "завтра в 14:00", "12 июля в 15:30") — не переспрашивай, принимай сразу.
21. ТЕЛЕФОН: В поле "Телефон" пиши ТОЛЬКО настоящий номер который дал клиент (например +48123456789). НИКОГДА не подставляй туда дату, время или что-либо другое. Если клиент ещё не дал телефон — спроси его и НЕ показывай резюме заявки пока телефона нет.
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
// Извлекает и нормализует время из текста в формат "H:MM" (понимает 14:00, 2 PM, 2:00 PM, 2pm, о 14)
function parseTimeFromText(str) {
  if (!str) return null;
  // Ищем час, минуты (опц.) и am/pm (опц.) вместе, чтобы правильно обработать "2:00 PM"
  const full = str.match(/(\d{1,2})(?::|\.)?(\d{2})?\s*(pm|am|рм|ам)/i);
  if (full) {
    let h = parseInt(full[1]);
    const min = full[2] || '00';
    if (/pm|рм/i.test(full[3]) && h < 12) h += 12;
    if (/am|ам/i.test(full[3]) && h === 12) h = 0;
    return `${h}:${min.padStart(2, '0')}`;
  }
  // Без am/pm — обычное время с двоеточием
  const colon = str.match(/(\d{1,2})[:.](\d{2})/);
  if (colon) return `${parseInt(colon[1])}:${colon[2].padStart(2, '0')}`;
  return null;
}

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
  rescheduleAsk: {
    'русский': 'Конечно, перенесём вашу запись! 😊 На какое время хотите перенести?',
    'польский': 'Oczywiście, przełożymy Twoją wizytę! 😊 Na jaką godzinę chcesz przełożyć?',
    'английский': 'Of course, we\'ll reschedule your appointment! 😊 What time would you like to move it to?'
  },
  changeServiceAsk: {
    'русский': 'Конечно, поменяем услугу! 😊 Какую услугу хотите вместо текущей?',
    'польский': 'Oczywiście, zmienimy usługę! 😊 Jaką usługę chcesz zamiast obecnej?',
    'английский': 'Of course, we\'ll change the service! 😊 Which service would you like instead?'
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

  // А: бот выключен для всего бизнеса — пересылаем сообщение барберу, сами не отвечаем
  const enabled = await isBotEnabled(business.igId);
  if (!enabled) {
    conv.messages.push({ role: "user", content: text });
    if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);
    await persistConv(convKey);
    const resOff = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: business.telegramChatId || TELEGRAM_CHAT_ID,
        text: `💬 Сообщение от клиента (бот выключен):\n"${text}"\n\n↩️ Ответьте reply НА ЭТО сообщение — ваш текст уйдёт клиенту в Instagram.`
      })
    });
    const dataOff = await resOff.json();
    if (dataOff.ok && dataOff.result?.message_id) {
      await saveMessageLink(dataOff.result.message_id, senderId, business.igId);
    }
    return;
  }

  // Б: бот отключён для этого конкретного клиента — барбер отвечает сам
  if (conv.manualMode) {
    conv.messages.push({ role: "user", content: text });
    if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);
    await persistConv(convKey);
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: business.telegramChatId || TELEGRAM_CHAT_ID,
        text: `💬 Клиент пишет (вы отвечаете сами):\n"${text}"\n\n↩️ Ответьте reply НА ЭТО сообщение — ваш текст уйдёт клиенту в Instagram.`,
        reply_markup: {
          inline_keyboard: [[{ text: "🤖 Вернуть бота", callback_data: `botback_${senderId}` }]]
        }
      })
    });
    // Сохраняем id этого сообщения чтобы reply на него нашёл клиента
    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      await saveMessageLink(data.result.message_id, senderId, business.igId);
    }
    return;
  }

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
    // Legacy-режим: ведём себя как ручной режим — пересылаем барберу с возможностью ответить reply
    conv.messages.push({ role: "user", content: text });
    if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);
    await persistConv(convKey);
    const resHm = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: business.telegramChatId || TELEGRAM_CHAT_ID,
        text: `💬 Клиент пишет (вы отвечаете сами):\n"${text}"\n\n↩️ Ответьте reply НА ЭТО сообщение — ваш текст уйдёт клиенту в Instagram.`,
        reply_markup: {
          inline_keyboard: [[{ text: "🤖 Вернуть бота", callback_data: `botback_${senderId}` }]]
        }
      })
    });
    const dataHm = await resHm.json();
    if (dataHm.ok && dataHm.result?.message_id) {
      await saveMessageLink(dataHm.result.message_id, senderId, business.igId);
    }
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

      // Случайное сообщение / ошибка (узко — проверяется последним, чтобы не перехватывать реальные намерения)
      const isAccidental = /случайн|ошибс(я|ь) (чат|адрес)|не туда|не тому|промахнул|написал не|забудь|забей|проигнор|не важно|неважно|wrong chat|wrong person|my bad|nevermind|never mind|ignore (that|this)|oops|pomyłka|nie to|pomylił|nieważne|zignoruj/i.test(lowerText);

      // Отмена записи
      const wantsCancel = /отмен|отменя|аннул|не приду|не прийду|не смогу|не получ|не буду|отказ|снять запис|снимите запис|убрать запис|удалить запис|убери запис|удали запис|расторг|не актуальн|передумал прих|передумала прих|cancel|cancell|anuluj|anulow|odwoł|rezygn|nie przyjd|nie dam rady|nie mogę przyj|call off|drop (my |the )?(booking|appointment)|remove (my |the )?(booking|appointment)|delete (my |the )?(booking|appointment)|not coming|can'?t (come|make it)|won'?t (come|make it)/i.test(lowerText);

      // Смена услуги
      const wantsChangeService = /(поменя|помен|смени|сменит|измени|изменит|заменит|замени|другую|другая|другой вид|вместо|переигр|перевыбр|махн)[^\n]{0,25}(услуг|стрижк|процедур|service|usług|zabieg)|(услуг|service|usług)[^\n]{0,25}(поменя|смени|измени|заменит|другую|change|zmien|inną)|не ту услуг|не та услуг|хочу другое|хочу другую|выбрал не то|выбрала не то|ошибся с услуг|change (the |my )?service|different service|another service|switch service|wrong service|zmien(ić|ic)? (usług|zabieg)|inn(ą|a) usług/i.test(lowerText);

      // Перенос записи на другое время (не путать со сменой услуги)
      const wantsReschedule = !wantsChangeService && /перенес|перенест|перенос|перенеси|передвин|сдвин|сдвиг|перекин|перебронир|перезап|переназнач|на другое время|другое время|другой день|другую дату|другое число|поменять время|поменять дату|сменить время|сменить дату|изменить время|изменить дату|изменить запись|поменять запись|попозже|пораньше|позже можно|раньше можно|не могу в это время|неудобное время|не подходит время|przełoż|przenie|przesun|inny termin|inn(ą|a) godzin|inny dzień|zmien(ić|ic)? (termin|godzin|dat)|reschedul|resched|move (my |the )?(booking|appointment|time)|move it|push (it )?(back|forward)|change (my |the )?(time|date|appointment|booking)|different (time|day|date)|another (time|day|date)|earlier|later( time)?|switch (my |the )?(time|appointment)/i.test(lowerText);

      // Новая (дополнительная) запись
      const wantsNewBooking = /снова|ещё раз|еще раз|опять|заново|новая запис|новую запис|записаться( снова| ещё| еще)?|хочу запис|запиши( меня)?|ещё одну|еще одну|дополнительн|another (appointment|booking|slot)|book again|again|new (appointment|booking)|one more|additional|znowu|jeszcze raz|ponownie|kolejn(ą|a)|now(ą|a) wizyt|umówić się jeszcze|zapisać się jeszcze/i.test(lowerText);

      // Явные намерения имеют приоритет над "случайным сообщением"
      const hasRealIntent = wantsCancel || wantsChangeService || wantsReschedule || wantsNewBooking;

      if (isAccidental && !hasRealIntent) {
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
      } else if (wantsReschedule || wantsChangeService || wantsNewBooking) {
        // Перенос / смена услуги / повторная запись
        const oldAptForRebook = db ? await db.collection("appointments").findOne(
          { senderId, businessId: business.igId, status: { $ne: "cancelled" } },
          { sort: { createdAt: -1 } }
        ) : null;

        // Телефон клиента из истории (чтобы не спрашивать заново)
        const phoneCands = (conv.messages
          .filter(m => m.role === "user")
          .map(m => m.content)
          .join(" ")
          .match(/\+?\d[\d\s\-()]{8,}\d/g) || [])
          .map(p => p.trim())
          .filter(p => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(p.replace(/\s/g, ''))) return false;
            const d = p.replace(/\D/g, '');
            return d.length >= 9 && d.length <= 15;
          });
        const phoneFromHistory = phoneCands.length ? [phoneCands[phoneCands.length - 1]] : null;

        if (wantsNewBooking && !wantsReschedule && !wantsChangeService) {
          // Совсем новая запись — начинаем с нуля
          const botGreeting = t('bookAgain', conv);
          conv.messages = [{ role: "assistant", content: botGreeting }];
          conv.completed = false;
          conv.humanMode = false;
          conv.awaitingTimeConfirm = null;
          conv.prevApt = null;
          conv.isRebooking = false;
          await persistConv(convKey);
          await sendInstagramMessage(senderId, botGreeting, business.accessToken);
          return;
        }

        // Перенос или смена услуги — СОХРАНЯЕМ известные данные клиента
        const knownName = oldAptForRebook?.name && oldAptForRebook.name !== "не указано" ? oldAptForRebook.name : null;
        const knownService = oldAptForRebook?.service && oldAptForRebook.service !== "не указана" ? oldAptForRebook.service : null;
        const knownPhone = phoneFromHistory ? phoneFromHistory[0].trim() : null;
        const knownDate = oldAptForRebook?.date || null;
        const knownTime = oldAptForRebook?.time || null;

        // Контекст для ИИ: что уже известно и что нужно изменить
        let contextNote = `[КОНТЕКСТ ДЛЯ ТЕБЯ, не показывай клиенту] У клиента УЖЕ ЕСТЬ запись:\n`;
        if (knownName) contextNote += `- Имя: ${knownName}\n`;
        if (knownService) contextNote += `- Услуга: ${knownService}\n`;
        if (knownDate && knownTime) contextNote += `- Текущая дата и время записи: ${knownDate} в ${knownTime}\n`;
        if (knownPhone) contextNote += `- Телефон: ${knownPhone}\n`;
        contextNote += `\n⚠️ ВАЖНО: Дата записи выше — это НЕ точка отсчёта! Если клиент скажет "завтра" или "послезавтра", считай их от СЕГОДНЯШНЕЙ даты (см. календарь в системном промпте), а НЕ от даты этой записи.\n`;
        contextNote += wantsChangeService
          ? `\nКлиент хочет ПОМЕНЯТЬ УСЛУГУ. НЕ спрашивай имя, дату, время и телефон — они уже известны выше, используй их. Спроси ТОЛЬКО новую услугу (покажи прайс-лист). Когда клиент выберет услугу — сразу покажи полное резюме заявки со всеми известными данными и поставь [READY].`
          : `\nКлиент хочет ПЕРЕНЕСТИ запись на другое время. НЕ спрашивай имя, услугу и телефон — они уже известны выше, используй их. Спроси ТОЛЬКО новое время (и дату если клиент не назвал). Когда клиент назовёт новое время — сразу покажи полное резюме заявки со всеми известными данными и поставь [READY].`;

        const botGreeting = wantsChangeService ? t('changeServiceAsk', conv) : t('rescheduleAsk', conv);
        conv.messages = [
          { role: "user", content: contextNote },
          { role: "assistant", content: botGreeting }
        ];
        conv.completed = false;
        conv.humanMode = false;
        conv.awaitingTimeConfirm = null;
        conv.prevApt = oldAptForRebook ? { date: oldAptForRebook.date, time: oldAptForRebook.time, telegramMessageId: oldAptForRebook.telegramMessageId } : null;
        conv.isRebooking = true;
        await persistConv(convKey);
        await sendInstagramMessage(senderId, botGreeting, business.accessToken);
        return;
      } else if (wantsCancel) {
        conv.completed = false;
        await persistConv(convKey);
        // Продолжаем — ИИ обработает отмену через [CANCEL]
      } else {
        // Обычный вопрос от записанного клиента — пусть ИИ ответит нормально, а не шаблоном
        const hasCtx = conv.messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[КОНТЕКСТ ДЛЯ ТЕБЯ"));
        if (!hasCtx && lastApt) {
          let note = `[КОНТЕКСТ ДЛЯ ТЕБЯ, не показывай клиенту] У клиента УЖЕ ЕСТЬ активная запись: ${lastApt.date} в ${lastApt.time}`;
          if (lastApt.name && lastApt.name !== "не указано") note += `, имя: ${lastApt.name}`;
          if (lastApt.service && lastApt.service !== "не указана") note += `, услуга: ${lastApt.service}`;
          note += `.\n⚠️ Дата записи выше — НЕ точка отсчёта. "Завтра"/"послезавтра" считай от СЕГОДНЯШНЕЙ даты (см. календарь), а не от даты записи.\nОтвечай на вопросы клиента обычно и по делу (о часах работы, адресе, услугах, ценах, его записи и т.д.). НЕ создавай новую заявку и НЕ ставь [READY]. Если клиент захочет отменить, перенести или поменять услугу — уточни что именно он хочет.`;
          conv.messages.push({ role: "user", content: note });
          await persistConv(convKey);
        }
        // НЕ делаем return — сообщение пойдёт к ИИ и он ответит нормально
      }
    }
  }

  // Проверяем занятость если клиент называет время
// Используем общий парсер (14:00, 2 pm, 2:00 PM) + запасной вариант для голого часа "на 11"
let userTime = parseTimeFromText(text);
if (!userTime) {
  const bareHourMatch = text.match(/(?:на|о|at|for|godz\.?|в)\s*(\d{1,2})(?:\s|$|\.|,)/i) || text.match(/^(\d{1,2})$/);
  if (bareHourMatch) {
    const h = parseInt(bareHourMatch[1]);
    if (h >= 8 && h <= 21) userTime = `${h}:00`; // только правдоподобные рабочие часы
  }
}

if (userTime && !conv.awaitingTimeConfirm) {
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
    const taken = await isSlotTaken(checkDate, userTime, business.igId, senderId);
    if (taken) {
      await sendInstagramMessage(senderId, t('slotTaken', conv, `${userTime} ${checkDate}`), business.accessToken);
      return;
    }
  }
}

  conv.messages.push({ role: "user", content: text });
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);

  const lang = detectLanguage(conv.messages[0]?.content || text);
const aiReply = await askClaude(conv.messages, business, lang, senderId);

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
    const normTime = parseTimeFromText(lastBotMsg.content);
    const isoDate = extractIsoDate(conv.messages);
    if (normTime && isoDate) {
      const taken = await isSlotTaken(isoDate, normTime, business.igId, senderId);
      if (taken) {
        conv.completed = false;
        await persistConv(convKey);
        await sendInstagramMessage(senderId, t('slotTaken', conv, normTime), business.accessToken);
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
      
      await bookSlot(isoDate, normTime, business.igId);
      // Сохраняем заявку для напоминания
const nameMatch = aiReply.match(/(?:Имя|Imię|Name)[:\s]+([^\n]+)/i);
const serviceMatch = aiReply.match(/(?:Услуга|Usługa|Service)[:\s]+([^\n]+)/i);
      if (db) {
  await db.collection("appointments").insertOne({
  senderId,
  businessId: business.igId,
  accessToken: business.accessToken,
  date: isoDate,
  time: normTime,
  name: nameMatch ? nameMatch[1]?.trim() : "не указано",
  service: serviceMatch ? serviceMatch[1]?.trim() : "не указана",
  telegramMessageId: conv.telegramMessageId || null,
  status: "confirmed",
  createdAt: new Date(),
  reminded: false
});
}
      console.log(`Слот забронирован: ${isoDate} ${normTime}`);
    }
  }

  // Отправляем клиенту
  let cleanReply = aiReply.replace(/\[.*?\]/g, "").replace(/\*+/g, "").trim();
  // Если ИИ забыл добавить ссылку на запись — добавляем её сами
  const bookingLink = "https://booksy.com/pl-pl/226901_barbershop-barbersquad_barber-shop_3_warszawa";
  if (!cleanReply.includes("booksy.com")) {
    const linkLabels = {
      'русский': '\n\n📅 Записаться также можно здесь: ',
      'польский': '\n\n📅 Możesz też zarezerwować tutaj: ',
      'английский': '\n\n📅 You can also book here: '
    };
    const joinedU = conv.messages.filter(m => m.role === "user").map(m => m.content).join(' ');
    let linkLang = 'английский';
    if (/[а-яёА-ЯЁ]/.test(joinedU)) linkLang = 'русский';
    else if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(joinedU) || /\b(czesc|tak|nie|jutro|godzina)\b/i.test(joinedU)) linkLang = 'польский';
    cleanReply += linkLabels[linkLang] + bookingLink;
  }
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
  // Клиент перенёс/перезаписался — показываем старую и новую запись, отвечаем на старую заявку
  const prevInfo = `${conv.prevApt.date} в ${conv.prevApt.time}`;
  const prevMsgId = conv.prevApt.telegramMessageId || conv.telegramMessageId || null;
  conv.isRebooking = false;
  conv.prevApt = null;
  await notifyDirector(`🔄 Клиент перенёс запись!\n\n❌ Старая запись: ${prevInfo} — отменена`, senderId, conv, business, null, prevMsgId);
} else {
  await notifyDirector("📅 Новая заявка на запись!", senderId, conv, business);
}
  await persistConv(convKey);
  return;
}

  if (/\[HUMAN\]/i.test(aiReply) || aiReply.includes("[НУЖЕН_ЧЕЛОВЕК]")) {
    const cleanReply = aiReply.replace(/\[.*?\]/g, "").replace(/\*+/g, "").trim();
    conv.humanMode = false;
    conv.manualMode = true; // передаём диалог барберу (единый флаг ручного режима)
    await persistConv(convKey);
    if (cleanReply) await sendInstagramMessage(senderId, cleanReply, business.accessToken);

    // Определяем причину, чтобы барбер сразу понял что случилось
    const lastUser = conv.messages.filter(m => m.role === "user").slice(-1)[0]?.content || "";
    const lu = lastUser.toLowerCase();
    let reason = "🙋 Клиент просит человека";
    if (/скидк|дешевл|подеш|дорого|snizh|discount|zniżk|taniej/i.test(lu)) reason = "💰 Клиент спрашивает про скидку";
    else if (/жалоб|недовол|ужасн|плохо|отврат|верните деньги|хамств|испортил|complaint|awful|terrible|refund|skarg|okropn/i.test(lu)) reason = "⚠️ Клиент недоволен / жалуется";
    else if (/аллерг|кожа|болит|раздражен|противопоказ|беремен|allerg|skin|pregnan|uczulen/i.test(lu)) reason = "🏥 Вопрос про здоровье / аллергию";
    else if (/дурак|идиот|тупой|сука|блять|нахуй|говно|мраз|fuck|shit|idiot|stupid|kurwa|chuj|debil/i.test(lu)) reason = "🚨 Клиент грубит / агрессия";

    const resH = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: business.telegramChatId || TELEGRAM_CHAT_ID,
        text: `${reason} — бот передал диалог вам.\n\n💬 Клиент пишет:\n"${lastUser}"\n\n↩️ Ответьте reply НА ЭТО сообщение — ваш текст уйдёт клиенту в Instagram.`,
        reply_markup: {
          inline_keyboard: [[{ text: "🤖 Вернуть бота", callback_data: `botback_${senderId}` }]]
        }
      })
    });
    const dataH = await resH.json();
    if (dataH.ok && dataH.result?.message_id) {
      await saveMessageLink(dataH.result.message_id, senderId, business.igId);
    }
    return;
  }

  if (/\[CANCEL\]/i.test(aiReply) || aiReply.includes("[ОТМЕНА_ЗАПИСИ]")) {
  const cleanReply = aiReply.replace(/\[.*?\]/g, "").replace(/\*+/g, "").trim();
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

  // Уведомляем барбера об отмене (ответом на исходную заявку)
  const cancelName = cancelledApt?.name || "Клиент";
  const cancelTime = cancelledApt ? `${cancelledApt.date} в ${cancelledApt.time}` : "неизвестное время";
  const cancelReplyId = cancelledApt?.telegramMessageId || conv.telegramMessageId || null;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: business.telegramChatId || TELEGRAM_CHAT_ID,
      text: `❌ Отмена записи!\n\n👤 Имя: ${cancelName}\n🕐 Время: ${cancelTime}\n\nКлиент отменил запись.`,
      ...(cancelReplyId ? { reply_to_message_id: cancelReplyId } : {})
    })
  });

  conv.completed = false;
  await persistConv(convKey);
  return;
}

  await persistConv(convKey);
  // Убираем ЛЮБЫЕ служебные теги в квадратных скобках (на любом языке) перед отправкой клиенту
  const finalReply = aiReply.replace(/\[[^\]]*\]/g, "").replace(/\*+/g, "").replace(/\n{3,}/g, "\n\n").trim();
  await sendInstagramMessage(senderId, finalReply, business.accessToken);
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function askClaude(messages, business, lang = 'польский', senderIdForBusy = null) {
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
        system: await buildSystemPrompt(business, lang, senderIdForBusy),
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
// Убираем markdown-звёздочки которые иногда добавляет ИИ, чтобы они не попали в заявку
const lastBot = (conv.messages.filter(m => m.role === "assistant").slice(-1)[0]?.content || "").replace(/\*+/g, "");

// Многоязычное извлечение (русский / польский / английский)
const serviceMatch = lastBot.match(/(?:Услуга|Usługa|Service)[:\s]+([^\n]+)/i)
  || lastBot.match(/(?:Стрижк|Strzyż|Combo|Buzz|Express)[^\n]*/i);
const timeMatch = lastBot.match(/(?:Время|Data i godzina|Godzina|Date and time|Time|Data)[:\s]+([^\n]+)/i)
  || lastBot.match(/\d{1,2}:\d{2}/);
// Телефон: только настоящие номера (не ISO-даты вроде 2026-07-13 и не время)
const phoneCandidates = msgs.join(" ").match(/\+?\d[\d\s\-()]{8,}\d/g) || [];
const phoneMatch = phoneCandidates
  .map(p => p.trim())
  .filter(p => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(p.replace(/\s/g, ''))) return false; // ISO дата
    const digits = p.replace(/\D/g, '');
    return digits.length >= 9 && digits.length <= 15; // телефон 9-15 цифр
  })
  .map(p => [p])[0] || null;

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
        { text: "💬 Отвечу сам", callback_data: `manual_${senderId}` }
      ],
      [
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
    await saveMessageLink(data.result.message_id, senderId, business.igId);
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

    // Б: барбер берёт диалог на себя для конкретного клиента
    if (data.startsWith("manual_")) {
      const senderId = data.replace("manual_", "");
      await answerCallback();
      const convKeyM = `${business.igId}_${senderId}`;
      const convM = await getConversation(convKeyM);
      convM.manualMode = true;
      await persistConv(convKeyM);
      const replyIdM = convM.telegramMessageId || null;
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `💬 Бот отключён для этого клиента. Теперь вы отвечаете сами.\n\n↩️ Отвечайте reply на сообщения клиента — они уйдут ему в Instagram.`,
          ...(replyIdM ? { reply_to_message_id: replyIdM } : {}),
          reply_markup: {
            inline_keyboard: [[{ text: "🤖 Вернуть бота", callback_data: `botback_${senderId}` }]]
          }
        })
      });
    }

    // Б: барбер возвращает бота этому клиенту
    if (data.startsWith("botback_")) {
      const senderId = data.replace("botback_", "");
      await answerCallback();
      const convKeyB = `${business.igId}_${senderId}`;
      const convB = await getConversation(convKeyB);
      convB.manualMode = false;
      convB.humanMode = false; // ВАЖНО: сбрасываем оба флага, иначе бот останется молчаливым
      await persistConv(convKeyB);
      await sendTg(`🤖 Бот снова отвечает этому клиенту.`);
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

// ─── А: команды включения/выключения бота ───────────────────────────────────
if (/^\/(выкл|off|stop|выключить)/i.test(text) && !body.message.from?.is_bot) {
  const bizOff = Object.values(loadBusinesses()).find(b => (b.telegramChatId || TELEGRAM_CHAT_ID) == chatId) || Object.values(loadBusinesses())[0];
  if (bizOff) {
    await setBotEnabled(bizOff.igId, false);
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "🔴 Бот ВЫКЛЮЧЕН.\n\nСообщения клиентов будут приходить вам сюда — отвечайте им reply.\n\nЧтобы включить обратно: /вкл" })
    });
  }
  return;
}

if (/^\/(вкл|on|start|включить)/i.test(text) && !body.message.from?.is_bot) {
  const bizOn = Object.values(loadBusinesses()).find(b => (b.telegramChatId || TELEGRAM_CHAT_ID) == chatId) || Object.values(loadBusinesses())[0];
  if (bizOn) {
    await setBotEnabled(bizOn.igId, true);
    // Снимаем ручной режим со всех клиентов этого бизнеса, чтобы ничего не зависло
    if (db) {
      await db.collection("conversations").updateMany(
        { key: { $regex: `^${bizOn.igId}_` } },
        { $set: { manualMode: false, humanMode: false } }
      );
    }
    for (const k of Object.keys(conversations)) {
      if (k.startsWith(`${bizOn.igId}_`)) {
        conversations[k].manualMode = false;
        conversations[k].humanMode = false;
      }
    }
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "🟢 Бот ВКЛЮЧЁН и снова отвечает всем клиентам автоматически." })
    });
  }
  return;
}

if (/^\/(статус|status)/i.test(text) && !body.message.from?.is_bot) {
  const bizSt = Object.values(loadBusinesses()).find(b => (b.telegramChatId || TELEGRAM_CHAT_ID) == chatId) || Object.values(loadBusinesses())[0];
  if (bizSt) {
    const on = await isBotEnabled(bizSt.igId);
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: on ? "🟢 Бот включён и отвечает клиентам." : "🔴 Бот выключен. Клиентам вы отвечаете сами.\n\nВключить: /вкл" })
    });
  }
  return;
}

// Команда сброса для тестирования: /сброс или /reset — чистит все данные
if ((text.toLowerCase().startsWith("/сброс") || text.toLowerCase().startsWith("/reset")) && !body.message.from?.is_bot) {
  if (db) {
    await db.collection("appointments").deleteMany({});
    await db.collection("slots").deleteMany({});
    await db.collection("conversations").deleteMany({});
    await db.collection("pending").deleteMany({});
    await db.collection("msglinks").deleteMany({});
    await db.collection("settings").deleteMany({});
  }
  for (const k of Object.keys(conversations)) delete conversations[k];
  for (const k of Object.keys(botEnabledCache)) delete botEnabledCache[k];
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: "🧹 Всё очищено! Все записи, слоты и диалоги удалены.\n\nКоманды:\n/вкл — включить бота\n/выкл — выключить бота\n/статус — проверить состояние\nМеню [число] — расписание на день" })
  });
  return;
}

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
      const business = businessReply;
      const convCustom = await getConversation(`${business.igId}_${senderId}`);

      const botOn = await isBotEnabled(business.igId);
      const isManual = convCustom.manualMode;

      if (!botOn || isManual) {
        // Бот выключен или ручной режим — отправляем ответ барбера клиенту КАК ЕСТЬ
        await sendInstagramMessage(senderId, text, business.accessToken);
        convCustom.messages.push({ role: "assistant", content: text });
        if (convCustom.messages.length > 20) convCustom.messages = convCustom.messages.slice(-20);
        await persistConv(`${business.igId}_${senderId}`);
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `✅ Отправлено клиенту.` })
        });
      } else {
        // Обычный режим — барбер предлагает время
        delete waitingForCustomTime[chatId];
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `✅ Время "${text}" отправлено клиенту!` })
        });
        await savePendingReschedule(senderId, text);
        await sendInstagramMessage(senderId, t('proposeOtherTime', convCustom, text), business.accessToken);
      }
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

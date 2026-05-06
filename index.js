const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "fastreply_secret";
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Память диалогов ────────────────────────────────────────────────────────
// Хранится в памяти сервера. При рестарте Render сбрасывается — для MVP окей.
// Структура: { [senderId]: { messages: [], humanMode: false, collected: {} } }
const conversations = {};

function getConversation(senderId) {
  if (!conversations[senderId]) {
    conversations[senderId] = {
      messages: [],      // история для Claude
      humanMode: false,  // true = бот молчит, директор общается сам
      collected: {}      // собранные данные: name, phone, service, time
    };
  }
  return conversations[senderId];
}

// ─── Системный промпт барбершопа ─────────────────────────────────────────────
// Замени данные ниже на реальные данные своего клиента
const SYSTEM_PROMPT = `Ты — вежливый и дружелюбный AI-ассистент барбершопа "Gentlemen's Cut" в Варшаве.
Отвечай коротко, по-человечески, без лишней воды. Пиши на том языке, на котором написал клиент.

ИНФОРМАЦИЯ О БАРБЕРШОПЕ:
- Адрес: Warszawa, ul. Marszałkowska 10
- График: Пн–Сб 10:00–20:00, воскресенье — выходной
- Телефон: +48 123 456 789

МАСТЕРА:
- Алексей — стрижки, стрижка + борода (опыт 8 лет)
- Марко — стрижки, окрашивание (специалист по текстуре)
- Дамир — борода, эспаньолка, бритьё опасной бритвой

ПРАЙС:
- Стрижка — 80 zł
- Стрижка + борода — 120 zł
- Борода / оформление — 50 zł
- Бритьё опасной бритвой — 70 zł
- Окрашивание — от 150 zł

ПРАВИЛА ПОВЕДЕНИЯ:
1. Если клиент хочет записаться — собери последовательно: имя, услугу, удобного мастера (или "любого"), дату и время, номер телефона.
2. Когда собрал все данные для записи — скажи клиенту "Отлично, передаю вашу заявку!" и добавь в конце сообщения специальный тег: [ЗАЯВКА_ГОТОВА]
3. Если клиент пишет "хочу поговорить с человеком", "свяжите меня с администратором", "хочу с менеджером" или подобное — ответь вежливо что передаёшь и добавь тег: [НУЖЕН_ЧЕЛОВЕК]
4. Никогда не придумывай данные которых нет выше. Если не знаешь — скажи "уточню у администратора".
5. Не отвечай на вопросы не связанные с барбершопом.`;

// ─── Роутер webhook ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("FastReply Instagram webhook is running");
});

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
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const messageText = event.message?.text;

          if (!senderId || !messageText) continue;
          if (event.message?.is_echo) continue;

          await handleMessage(senderId, messageText);
        }
      }
    }
    return res.status(200).json({ status: "EVENT_RECEIVED" });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).json({ status: "ERROR_HANDLED" });
  }
});

// ─── Главная логика ──────────────────────────────────────────────────────────
async function handleMessage(senderId, text) {
  const conv = getConversation(senderId);

  // Если директор уже подключился — бот молчит
  if (conv.humanMode) {
    console.log(`[humanMode] Молчим для ${senderId}: "${text}"`);
    // Можно уведомить директора о новом сообщении клиента
    await notifyDirector(
      `💬 Клиент (${senderId}) продолжает:\n"${text}"`,
      senderId,
      conv
    );
    return;
  }

  // Добавляем сообщение клиента в историю
  conv.messages.push({ role: "user", content: text });

  // Ограничиваем историю последними 20 сообщениями (экономия токенов)
  if (conv.messages.length > 20) {
    conv.messages = conv.messages.slice(-20);
  }

  // Запрос к Claude
  const aiReply = await askClaude(conv.messages);

  if (!aiReply) {
    await sendInstagramMessage(senderId, "Извините, произошла ошибка. Попробуйте чуть позже.");
    return;
  }

  // Добавляем ответ ассистента в историю
  conv.messages.push({ role: "assistant", content: aiReply });

  // Проверяем теги в ответе
  if (aiReply.includes("[ЗАЯВКА_ГОТОВА]")) {
    const cleanReply = aiReply.replace("[ЗАЯВКА_ГОТОВА]", "").trim();
    await sendInstagramMessage(senderId, cleanReply);
    await notifyDirector("📅 Новая заявка на запись!", senderId, conv);
    return;
  }

  if (aiReply.includes("[НУЖЕН_ЧЕЛОВЕК]")) {
    const cleanReply = aiReply.replace("[НУЖЕН_ЧЕЛОВЕК]", "").trim();
    conv.humanMode = true;
    await sendInstagramMessage(senderId, cleanReply);
    await notifyDirector("🙋 Клиент хочет поговорить с человеком!", senderId, conv);
    return;
  }

  // Обычный ответ
  await sendInstagramMessage(senderId, aiReply);
}

// ─── Claude API ──────────────────────────────────────────────────────────────
async function askClaude(messages) {
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is missing");
    return null;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // быстрый и дешёвый для чата
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Claude API error:", data);
      return null;
    }

    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error("Claude fetch error:", err);
    return null;
  }
}

// ─── Уведомление директора в Telegram ───────────────────────────────────────
async function notifyDirector(title, senderId, conv) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram не настроен, пропускаем уведомление");
    return;
  }

  // Собираем последние 10 сообщений диалога
  const history = conv.messages
    .slice(-10)
    .map(m => `${m.role === "user" ? "👤 Клиент" : "🤖 Бот"}: ${m.content}`)
    .join("\n");

  const message = `${title}\n\nID клиента: ${senderId}\n\n📝 История диалога:\n${history}`;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      })
    });
    console.log("Telegram уведомление отправлено");
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

// ─── Instagram API ───────────────────────────────────────────────────────────
async function sendInstagramMessage(recipientId, text) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    console.error("INSTAGRAM_ACCESS_TOKEN is missing");
    return;
  }

  const response = await fetch("https://graph.instagram.com/v21.0/me/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text }
    })
  });

  const data = await response.json();
  console.log("Instagram send response:", data);

  if (!response.ok) {
    console.error("Failed to send Instagram message:", data);
  }
}

// ─── Запуск ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FastReply server running on port ${PORT}`);
});

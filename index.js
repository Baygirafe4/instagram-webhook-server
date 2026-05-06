const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "fastreply_secret";
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Память диалогов ─────────────────────────────────────────────────────────
const conversations = {};

function getConversation(senderId) {
  if (!conversations[senderId]) {
    conversations[senderId] = {
      messages: [],
      humanMode: false,
      collected: {}
    };
  }
  return conversations[senderId];
}

// ─── Системный промпт ─────────────────────────────────────────────────────────
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
2. Когда собрал ВСЕ данные для записи (имя + услуга + мастер + дата/время + телефон) — скажи клиенту "Отлично, передаю вашу заявку!" и в самом конце сообщения обязательно добавь точно этот тег: [ЗАЯВКА_ГОТОВА]
3. Если клиент пишет "хочу поговорить с человеком", "свяжите меня с администратором", "хочу с менеджером" или подобное — ответь вежливо что передаёшь и в конце добавь точно этот тег: [НУЖЕН_ЧЕЛОВЕК]
4. Никогда не придумывай данные которых нет выше. Если не знаешь — скажи "уточню у администратора".
5. Не отвечай на вопросы не связанные с барбершопом.
6. ВАЖНО: теги [ЗАЯВКА_ГОТОВА] и [НУЖЕН_ЧЕЛОВЕК] пиши точно так, в квадратных скобках, на русском.`;

// ─── Webhook роутер ───────────────────────────────────────────────────────────
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

// ─── Главная логика ───────────────────────────────────────────────────────────
async function handleMessage(senderId, text) {
  const conv = getConversation(senderId);

  if (conv.humanMode) {
    console.log(`[humanMode] Молчим для ${senderId}: "${text}"`);
    await notifyDirector(`💬 Клиент пишет:\n"${text}"`, senderId, conv);
    return;
  }

  conv.messages.push({ role: "user", content: text });

  if (conv.messages.length > 20) {
    conv.messages = conv.messages.slice(-20);
  }

  console.log(`>>> Отправляем запрос к Claude для ${senderId}...`);
  const aiReply = await askClaude(conv.messages);

  if (!aiReply) {
    console.error(">>> Claude вернул пустой ответ!");
    await sendInstagramMessage(senderId, "Извините, произошла ошибка. Попробуйте чуть позже.");
    return;
  }

  conv.messages.push({ role: "assistant", content: aiReply });

  console.log("=== Claude reply ===");
  console.log(aiReply);
  console.log("===================");

  if (aiReply.includes("[ЗАЯВКА_ГОТОВА]")) {
    console.log(">>> Тег ЗАЯВКА_ГОТОВА найден! Отправляем уведомление в Telegram...");
    const cleanReply = aiReply.replace("[ЗАЯВКА_ГОТОВА]", "").trim();
    await sendInstagramMessage(senderId, cleanReply);
    await notifyDirector("📅 Новая заявка на запись!", senderId, conv);
    console.log(">>> Готово!");
    return;
  }

  if (aiReply.includes("[НУЖЕН_ЧЕЛОВЕК]")) {
    console.log(">>> Тег НУЖЕН_ЧЕЛОВЕК найден! Переключаем на человека...");
    const cleanReply = aiReply.replace("[НУЖЕН_ЧЕЛОВЕК]", "").trim();
    conv.humanMode = true;
    await sendInstagramMessage(senderId, cleanReply);
    await notifyDirector("🙋 Клиент хочет поговорить с человеком!", senderId, conv);
    console.log(">>> Готово!");
    return;
  }

  console.log(">>> Обычный ответ, тегов не найдено");
  await sendInstagramMessage(senderId, aiReply);
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function askClaude(messages) {
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY отсутствует!");
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
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Claude API error:", JSON.stringify(data));
      return null;
    }

    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error("Claude fetch error:", err);
    return null;
  }
}

// ─── Telegram уведомление ─────────────────────────────────────────────────────
async function notifyDirector(title, senderId, conv) {
  console.log(`>>> notifyDirector вызван: ${title}`);
  console.log(`>>> TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? "есть" : "ОТСУТСТВУЕТ"}`);
  console.log(`>>> TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID ? TELEGRAM_CHAT_ID : "ОТСУТСТВУЕТ"}`);

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(">>> Telegram не настроен, пропускаем");
    return;
  }

  const history = conv.messages
    .slice(-10)
    .map(m => `${m.role === "user" ? "👤 Клиент" : "🤖 Бот"}: ${m.content}`)
    .join("\n\n");

  const message = `${title}\n\nID клиента: ${senderId}\n\n📝 История диалога:\n${history}`;

  try {
    console.log(`>>> Отправляем в Telegram chat_id: ${TELEGRAM_CHAT_ID}`);
    const tgResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message
        })
      }
    );

    const tgData = await tgResponse.json();
    console.log(">>> Telegram ответ:", JSON.stringify(tgData));

    if (!tgResponse.ok) {
      console.error(">>> Telegram ошибка:", tgData);
    } else {
      console.log(">>> Telegram уведомление успешно отправлено!");
    }
  } catch (err) {
    console.error(">>> Telegram fetch error:", err);
  }
}

// ─── Instagram API ────────────────────────────────────────────────────────────
async function sendInstagramMessage(recipientId, text) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    console.error("INSTAGRAM_ACCESS_TOKEN отсутствует!");
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
  console.log("Instagram send response:", JSON.stringify(data));

  if (!response.ok) {
    console.error("Failed to send Instagram message:", data);
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FastReply server running on port ${PORT}`);
  console.log(`ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "✓ есть" : "✗ отсутствует"}`);
  console.log(`INSTAGRAM_ACCESS_TOKEN: ${INSTAGRAM_ACCESS_TOKEN ? "✓ есть" : "✗ отсутствует"}`);
  console.log(`TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? "✓ есть" : "✗ отсутствует"}`);
  console.log(`TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID ? "✓ " + TELEGRAM_CHAT_ID : "✗ отсутствует"}`);
});

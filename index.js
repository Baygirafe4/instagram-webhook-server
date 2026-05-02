const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "fastreply_secret";
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;

app.get("/", (req, res) => {
  res.send("Instagram webhook server is running");
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
  console.log("Instagram webhook event:", JSON.stringify(req.body, null, 2));

  try {
    if (req.body.object === "instagram") {
      for (const entry of req.body.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const messageText = event.message?.text;

          if (!senderId || !messageText) continue;
          if (event.message?.is_echo) continue;

          const reply = getReply(messageText);
          await sendInstagramMessage(senderId, reply);
        }
      }
    }

    return res.status(200).json({ status: "EVENT_RECEIVED" });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).json({ status: "ERROR_HANDLED" });
  }
});

function getReply(text) {
  const lower = text.toLowerCase();

  if (
    lower.includes("цена") ||
    lower.includes("стоимость") ||
    lower.includes("прайс") ||
    lower.includes("price")
  ) {
    return "Цены: стрижка — 80 zł, стрижка + борода — 120 zł, борода — 50 zł. Хотите записаться?";
  }

  if (
    lower.includes("запись") ||
    lower.includes("записаться") ||
    lower.includes("хочу") ||
    lower.includes("appointment")
  ) {
    return "Отлично. Напишите, пожалуйста: имя, услугу, удобный день/время и номер телефона.";
  }

  if (
    lower.includes("адрес") ||
    lower.includes("где") ||
    lower.includes("location")
  ) {
    return "Мы находимся по адресу: Warszawa, ul. Marszałkowska 10.";
  }

  if (
    lower.includes("график") ||
    lower.includes("работаете") ||
    lower.includes("часы") ||
    lower.includes("hours")
  ) {
    return "График работы: Пн-Сб 10:00–20:00, воскресенье — выходной.";
  }

  if (
    lower.includes("человек") ||
    lower.includes("менеджер") ||
    lower.includes("админ")
  ) {
    return "Хорошо, я передам ваш вопрос администратору. Напишите, пожалуйста, вопрос одним сообщением.";
  }

  return "Привет! Я быстрый ассистент. Могу подсказать цены, адрес, график или помочь с записью. Напишите, что вас интересует.";
}

async function sendInstagramMessage(recipientId, text) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    console.error("INSTAGRAM_ACCESS_TOKEN is missing");
    return;
  }

  const url = "https://graph.instagram.com/v21.0/me/messages";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient: {
        id: recipientId
      },
      message: {
        text
      }
    })
  });

  const data = await response.json();
  console.log("Instagram send response:", data);

  if (!response.ok) {
    console.error("Failed to send Instagram message:", data);
  }
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

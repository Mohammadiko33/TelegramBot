const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();
const db = require("./db");

const token = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

if (!token || !ADMIN_ID) {
  console.error("❌ لطفاً TOKEN و ADMIN_ID را در فایل .env تنظیم کنید");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// وضعیت کاربران و پاسخ‌های ادمین
const userStates = new Map();
const adminReplyStates = new Map(); // { adminId: { targetUserId, messages: [] } }

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const message = `� سلام! به ربات پرسش و پاسخ خوش آمدید.\n\n�📘 این ربات برای پرسیدن سؤالات شما طراحی شده است.\nشما می‌توانید سؤال بپرسید و پاسخ آن را بعداً از همین‌جا دریافت کنید.\n\n🧭 دستورات در دسترس:\n/start — شروع و نمایش توضیحات\n/question — پرسیدن سؤال جدید\n/quickAnswer — نمایش سؤالات و پاسخ‌های آماده\n/cancel — لغو پرسیدن سؤال\n\n📌 نمونه سؤالات آماده:`;

  const sampleQuestions = (Array.isArray(db) ? db : [])
    .filter((item) => [15, 32, 44].includes(item.id))
    .map(
      (item) => `• <a href="https://t.me/questions_islam/${item.id}">${item.question}</a>`
    )
    .join("\n");

  bot.sendMessage(chatId, message + "\n" + sampleQuestions, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
});

bot.onText(/\/quickAnswer/, (msg) => {
  const chatId = msg.chat.id;
  if (!Array.isArray(db) || !db.length) {
    bot.sendMessage(chatId, "هیچ پاسخ آماده‌ای وجود ندارد.");
    return;
  }

  let message = "📚 پاسخ‌های آماده:\n\n";
  db.forEach((item) => {
    message += `🔹 <a href="https://t.me/questions_islam/${item.id}">${item.question}</a>\n`;
    message += `🔗 <a href="${item.answerSite}">مشاهده پاسخ در سایت</a>\n\n`;
  });

  bot.sendMessage(chatId, message, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
});

bot.onText(/\/question/, (msg) => {
  const userId = msg.chat.id;
  userStates.set(userId, { askingQuestion: true });

  bot.sendMessage(
    userId,
    "🟢 لطفاً سؤال خود را بنویسید.\n(برای لغو بنویسید /cancel)"
  );

  setTimeout(() => {
    const state = userStates.get(userId);
    if (state && state.askingQuestion) {
      userStates.set(userId, { askingQuestion: false });
      bot.sendMessage(userId, "⌛ زمان پرسش به پایان رسید. درخواست لغو شد.");
    }
  }, 5 * 60 * 1000);
});

bot.onText(/\/cancel/, (msg) => {
  const userId = msg.chat.id;
  const state = userStates.get(userId);

  if (state && state.askingQuestion) {
    userStates.set(userId, { askingQuestion: false });
    bot.sendMessage(userId, "❎ پرسیدن سؤال لغو شد.");
  } else {
    bot.sendMessage(userId, "⚠️ شما در حالت پرسش سؤال نیستید.");
  }
});

bot.on("message", async (msg) => {
  const text = msg.text;
  const userId = msg.chat.id;

  if (!text || text.startsWith("/")) return;

  // ✅ اگر کاربر سؤال می‌پرسد
  const state = userStates.get(userId);
  if (state && state.askingQuestion) {
    userStates.set(userId, { askingQuestion: false });

    // ارسال/فوروارد پیام کاربر به ادمین
    const username = msg.from.username
      ? `@${msg.from.username}`
      : msg.from.first_name || "کاربر ناشناس";

    try {
      await bot.forwardMessage(ADMIN_ID, userId, msg.message_id);
      await bot.sendMessage(
        ADMIN_ID,
        `📩 یک سؤال جدید از کاربر ${username} دریافت شد. برای پاسخ‌دهی به پیام فرستاده‌شده پاسخ دهید (reply) و سپس «پایان» را ارسال کنید.`
      );
    } catch (err) {
      await bot.sendMessage(
        ADMIN_ID,
        `📩 یک سؤال جدید از کاربر ${username}:\n\n${text}`
      );
    }

    bot.sendMessage(userId, "✅ سؤال شما ارسال شد. پس از بررسی پاسخ داده می‌شود.");
    return;
  }

  if (userId.toString() === ADMIN_ID.toString()) {
    const adminState = adminReplyStates.get(userId);

    if (adminState) {
      if (text.trim().toLowerCase() === "پایان") {
        const { targetUserId, messages } = adminState;

        if (!messages.length) {
          bot.sendMessage(userId, "⚠️ پاسخی برای ارسال وجود ندارد.");
          adminReplyStates.delete(userId);
          return;
        }

        for (const replyText of messages) {
          await bot.sendMessage(targetUserId, replyText);
        }

        await bot.sendMessage(userId, "✅ پاسخ‌ها برای کاربر ارسال شدند.");
        adminReplyStates.delete(userId);
        return;
      }

      adminState.messages.push(text);
      adminReplyStates.set(userId, adminState);
      bot.sendMessage(userId, "📝 پاسخ ذخیره شد (با نوشتن «پایان» ارسال می‌شود).");
      return;
    }
  }

  const validTexts = [
    "سوال دارم",
    "یک تضاد پیدا کردم تو اسلام",
    "یک مشکل پیدا کردم تو اسلام",
  ];
  if (validTexts.includes(text.trim())) {
    bot.sendMessage(
      userId,
      "برای شروع پرسیدن سؤال از دستور /question استفاده کنید."
    );
  } else {
    bot.sendMessage(
      userId,
      "اگر می‌خواهید سؤال بپرسید از دستور /question استفاده کنید."
    );
  }
});

bot.on("message", (msg) => {
  const userId = msg.chat.id;

  if (userId.toString() !== ADMIN_ID.toString()) return;
  if (!msg.reply_to_message) return;

  const forwardFrom = msg.reply_to_message.forward_from;
  if (!forwardFrom || !forwardFrom.id) {
    bot.sendMessage(
      userId,
      "⚠️ کاربر مقصد پیدا نشد. لطفاً به پیام فوروارد شده‌ی کاربر پاسخ دهید (reply) تا حالت پاسخ‌دهی فعال شود."
    );
    return;
  }

  const targetUserId = forwardFrom.id;
  const targetUsername = forwardFrom.username ? `@${forwardFrom.username}` : (forwardFrom.first_name || 'کاربر');

  bot.sendMessage(
    userId,
    `✏️ حالت پاسخ‌دهی به ${targetUsername} فعال شد.\nهر پیام شما ذخیره می‌شود تا وقتی بنویسید «پایان».`
  );

  adminReplyStates.set(userId, {
    targetUserId,
    messages: [],
  });
});
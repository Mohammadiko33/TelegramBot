require('dotenv').config();
const telegramBot = require('node-telegram-bot-api');
const token = process.env.TOKEN || null;
const adminId = process.env.ADMIN_ID;
const questions = require('./db');

const bot = new telegramBot(token, { polling: true });

// discover bot username for deep links
// prefer BOT_USERNAME from env (set this in .env) to make deep links reliable
let botUsername = process.env.BOT_USERNAME || null;
if (!botUsername) {
  bot.getMe().then(info => {
    botUsername = info.username;
    console.log('Bot username:', botUsername);
  }).catch(() => {
    console.warn('Could not get bot username; deep links may not work until available.');
  });
} else {
  console.log('Using BOT_USERNAME from env:', botUsername);
}

// Setup mongoose and Feedback model (local DB questionIslamBot)
const mongoose = require('mongoose');
mongoose.connect('mongodb://127.0.0.1:27017/questionIslamBot', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('Connected to MongoDB questionIslamBot')).catch(err => console.error('MongoDB connect error:', err && err.message));

const feedbackSchema = new mongoose.Schema({
  questionId: Number,
  questionText: String,
  userChatId: Number,
  userId: Number,
  username: String,
  userFeedback: String,
  adminReplies: [String],
  status: { type: String, enum: ['waiting_for_text', 'waiting_admin', 'completed'], default: 'waiting_for_text' },
  createdAt: { type: Date, default: Date.now }
});
const Feedback = mongoose.model('Feedback', feedbackSchema);

// Store user states
const userStates = new Map();

// Store admin replies for each user
const adminReplies = new Map();

// Persist mapping username-or-id -> chatId so admin replies can be delivered later
const userChats = new Map();

// Function to cancel user's question state
const cancelQuestionState = (chatId) => {
  if (userStates.has(chatId)) {
    clearTimeout(userStates.get(chatId).timeout);
    userStates.delete(chatId);
    return true;
  }
  return false;
};

// Start command handler
// handle /start and deep links like /start feedback_<id>
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const payload = match && match[1] ? match[1] : null;

  // If payload is feedback_<id>, forward a feedback notification to admin
  if (payload && payload.startsWith('feedback_')) {
    const qid = payload.split('_')[1];
    const q = questions.find(x => String(x.id) === String(qid));
    const username = msg.from.username || '';

    // create feedback document
    const fb = new Feedback({
      questionId: Number(qid),
      questionText: q ? q.question : '',
      userChatId: msg.from.id,
      userId: msg.from.id,
      username: username ? `@${username}` : '',
      status: 'waiting_for_text'
    });
    await fb.save();

    // set user state to waiting for feedback text, store feedbackId
    const timeout = setTimeout(() => {
      if (userStates.has(chatId) && userStates.get(chatId).state === 'waiting_for_feedback') {
        userStates.delete(chatId);
      }
    }, 5 * 60 * 1000);
    userStates.set(chatId, { state: 'waiting_for_feedback', feedbackId: fb._id, timeout });

    await bot.sendMessage(chatId, `لطفا متن بازخورد برای پست "${q ? q.question : ''}" را بنویسید. پس از ارسال، من آن را برای مدیریت می‌فرستم.`);
    return;
  }

  // Default welcome message
  const welcomeMessage = `🌟 خوش آمدید به ربات پاسخگوی سوالات اسلامی!\n\n🤖 این ربات به شما کمک می‌کند تا:\n- سوالات خود درباره اسلام را بپرسید\n- به پاسخ‌های موجود دسترسی داشته باشید\n- با مطالب آموزنده آشنا شوید\n\n📝 دستورات موجود:\n/start - شروع مجدد ربات\n/quickAnswer - مشاهده لیست تمام سوالات و پاسخ‌ها\n/question - پرسیدن سوال جدید\n/cancel - لغو عملیات فعلی\n\n🔍 نمونه سوالات موجود:`;

  await bot.sendMessage(chatId, welcomeMessage);

  // Show 3 sample questions (IDs 15, 32, 44)
  const sampleQuestions = questions.filter(q => [15].includes(q.id));
  let questionsMessage = '';
  sampleQuestions.forEach(q => {
    questionsMessage += `❓ ${q.question}\n`;
  });

  await bot.sendMessage(chatId, questionsMessage || '❗️ نمونه سوال در حال حاضر موجود نیست.');
});

// Quick Answer command handler
bot.onText(/\/quickAnswer/, async (msg) => {
  const chatId = msg.chat.id;

  // Build a single HTML message that contains all questions and site links (question text and "پاسخ در سایت" are links)
  let combined = '📚 لیست تمام سوالات و پاسخ‌ها:\n\n';
  // ensure we have the bot username for deep links
  if (!botUsername) {
    try {
      const info = await bot.getMe();
      botUsername = info.username;
    } catch (e) {
      console.error('Failed to get bot username for deep links:', e && e.message);
    }
  }

  questions.forEach((q, idx) => {
    // question text links to channel post, 'پاسخ در سایت' links to the site
    combined += `${idx + 1}. <a href="https://t.me/questions_islam/${q.id}">${q.question}</a>\n`;
    combined += `<a href="${q.answerSite}">پاسخ در سایت</a>\n`;
      // build deep link to open chat with bot with payload 'feedback_<id>'
    const usernameForLink = botUsername ? botUsername : '<your_bot_username>';
      const deepLink = `https://t.me/${usernameForLink}?start=feedback_${q.id}`;
      combined += `<a href="${deepLink}">ارسال بازخورد</a>\n\n`;
  });
  // send single aggregated message with inline HTML links (deep-links for feedback)
  await bot.sendMessage(chatId, combined, {
    parse_mode: 'HTML',
    disable_web_page_preview: false
  });

  // send a sticker after the combined message
  try {
    await bot.sendSticker(chatId, 'CAACAgQAAxkBAAIDaWRqhP4v7h8AAUtplwrqAAHMXt5c3wACPxAAAqbxcR4V0yHjRsIKVy8E');
  } catch (e) {
    // ignore sticker errors silently
    console.error('Failed to send sticker:', e && e.message);
  }
});

// Question command handler
bot.onText(/\/question/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || 'بدون نام کاربری';

  // Set user state for asking question
  const timeout = setTimeout(() => {
    if (userStates.has(chatId)) {
      bot.sendMessage(chatId, '⏳ زمان پرسیدن سوال به پایان رسید. لطفاً دوباره تلاش کنید.');
      cancelQuestionState(chatId);
    }
  }, 5 * 60 * 1000); // 5 minutes timeout

  userStates.set(chatId, {
    state: 'waiting_for_question',
    userId,
    username,
    timeout
  });

  bot.sendMessage(chatId, '📝 لطفاً سوال خود را بنویسید.\n\nبرای لغو از دستور /cancel استفاده کنید.');
});

// Cancel command handler
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;

  if (cancelQuestionState(chatId)) {
    bot.sendMessage(chatId, '❌ عملیات لغو شد.');
  } else {
    bot.sendMessage(chatId, '❗️ عملیاتی برای لغو کردن وجود ندارد.');
  }
});

// Message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Ignore commands
  if (!text || text.startsWith('/')) return;
  if (text === "سلام") {
    bot.sendMessage(chatId, " و علیکم سلام دوست اهل پرشیا من \n اگه سوالی داری /question رو بزن")
    return;
  }
  if (
    text.includes("کیر") ||
    text.includes("کون") ||
    text.includes("کص") ||
    text.includes("کس") ||
    text.includes("dick") ||
    text.includes("sex") ||
    text.includes("porn") ||
    text.includes("pussy") ||
    text.includes("ass")
  ) {
    bot.sendMessage(chatId, `
      لطفا از کلمات شرم آور استفاده نکنید 
      بیایید محترمانه حرف بزنیم تا گفت وگو خوشایندتر بشه 
      `)
    return;
  }

  // Check if user is in question state
  if (userStates.has(chatId)) {
    const userState = userStates.get(chatId);

    // If waiting for feedback text
    if (userState.state === 'waiting_for_feedback') {
      const fbId = userState.feedbackId;
      try {
        const fb = await Feedback.findById(fbId);
        if (fb) {
          fb.userFeedback = text;
          fb.status = 'waiting_admin';
          await fb.save();

          const adminMsg = `📩 بازخورد جدید از ${fb.username || ''} برای سوال:\n\n${fb.questionText}\n\nمتن بازخورد:\n${text}\n\nFeedbackID:${fb._id}\nchatId:${fb.userChatId}`;
          await bot.sendMessage(adminId, adminMsg);
          await bot.sendMessage(chatId, '✅ بازخورد شما ثبت و برای مدیریت ارسال شد.');
        }
      } catch (e) {
        console.error('Error saving feedback:', e && e.message);
      }
      clearTimeout(userState.timeout);
      userStates.delete(chatId);
      return;
    }

    if (userState.state === 'waiting_for_question') {
      // Forward question to admin
      const usernameDisplay = userState.username && userState.username !== 'بدون نام کاربری' ? `@${userState.username}` : '';
      const questionMessage = `📩 یک سؤال جدید از کاربر ${usernameDisplay}\n\n${text}\n\nلینک پست: https://t.me/questions_islam/ask\nchatId:${chatId}`;
      // store chat id so admin replies can be sent later
      const key = userState.username && userState.username !== 'بدون نام کاربری' ? userState.username : `id_${chatId}`;
      userChats.set(key, chatId);
      adminReplies.set(key, []);
      await bot.sendMessage(adminId, questionMessage);

  await bot.sendMessage(chatId, '✅ سوال شما دریافت شد و به زودی پاسخ داده خواهد شد.');

      cancelQuestionState(chatId);
      return;
    }
  }

  // Handle specific text messages
  const validQuestionPhrases = [
    'سوال دارم',
    'یک تضاد پیدا کردم تو اسلام',
    'یک مشکل پیدا کردم تو اسلام'
  ];

  if (validQuestionPhrases.includes(text)) {
    bot.sendMessage(
      chatId,
      'برای پرسیدن سوال، لطفاً از دستور /question استفاده کنید یا یکی از عبارات زیر را بنویسید:\n- سوال دارم\n- یک تضاد پیدا کردم تو اسلام\n- یک مشکل پیدا کردم تو اسلام'
    );
  } else {
    bot.sendMessage(
      chatId,
      'اگر می‌خواهید سوالی بپرسید، لطفاً از دستور /question استفاده کنید یا یکی از عبارات زیر را بنویسید:\n- سوال دارم\n- یک تضاد پیدا کردم تو اسلام\n- یک مشکل پیدا کردم تو اسلام'
    );
  }
});

// (Old admin reply handler removed) Replies are now processed by the improved handler

// Handle callback queries from inline buttons (like ارسال بازخورد)
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data || '';
  const fromId = callbackQuery.from.id;
  const messageId = callbackQuery.message ? callbackQuery.message.message_id : null;

  if (data.startsWith('feedback:')) {
    const qid = data.split(':')[1];
    // find question by id
    const q = questions.find(x => String(x.id) === String(qid));
    const user = callbackQuery.from;

    const feedbackMsg = `📣 درخواست بازخورد از کاربر @${user.username || 'بدون نام کاربری'}:\n\nسوال: ${q ? q.question : 'نامشخص'}\nلینک پست: https://t.me/questions_islam/${qid}\n\nchatId:${callbackQuery.from.id}`;

    // send to admin
    await bot.sendMessage(adminId, feedbackMsg);

    // Acknowledge the callback to the user
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'بازخورد برای مدیریت ارسال شد.' });
  }
});

// Improved admin reply handler: listen to admin messages replying to bot's forwarded question messages
bot.on('message', async (msg) => {
  // Only proceed if message is from admin and is a reply to a bot message containing 'chatId:'
  if (msg.from.id.toString() !== adminId || !msg.reply_to_message) return;

  const original = msg.reply_to_message.text || '';
  // If this admin reply references a FeedbackID, handle feedback flow
  const feedbackMatch = original.match(/FeedbackID:([0-9a-fA-F]{24})/);
  if (feedbackMatch) {
    const fbId = feedbackMatch[1];
    const text = msg.text || '';

    if (text.trim().toLowerCase() === 'پایان') {
      // send collected admin replies to user and mark completed
      const fb = await Feedback.findById(fbId);
      if (fb && fb.adminReplies && fb.adminReplies.length > 0) {
        // send a header first
        await bot.sendMessage(fb.userChatId, 'پاسخ ادمین به بازخورد شما:');
        for (const r of fb.adminReplies) {
          await bot.sendMessage(fb.userChatId, r);
        }
        fb.status = 'completed';
        fb.adminReplies = [];
        await fb.save();
        await bot.sendMessage(adminId, '✅ پاسخ‌ها به کاربر ارسال شد.');
      } else {
        await bot.sendMessage(adminId, '⚠️ هیچ پاسخی ثبت نشده است.');
      }
      return;
    }

    // store admin reply
    await Feedback.findByIdAndUpdate(fbId, { $push: { adminReplies: text }, $set: { status: 'waiting_admin' } });
    await bot.sendMessage(adminId, '✅ پاسخ ذخیره شد. برای ارسال به کاربر، لطفاً "پایان" را ارسال کنید.');
    return;
  }
  
  // Fallback: previous chatId-based flow
  if (!original.includes('chatId:')) return;
  // Extract chatId from original message
  const match = original.match(/chatId:(\d+)/);
  if (!match) return;
  const targetChatId = Number(match[1]);

  const text = msg.text || '';

  // If admin sends 'پایان' we send collected replies to user
  if (text.trim().toLowerCase() === 'پایان') {
    // Determine key used in userChats map (could be username or id_chatId)
    // First try to find by chatId
    let keyFound = null;
    for (const [k, v] of userChats.entries()) {
      if (v === targetChatId) {
        keyFound = k;
        break;
      }
    }

    const replies = keyFound ? (adminReplies.get(keyFound) || []) : [];
    if (replies.length > 0) {
      await bot.sendMessage(targetChatId, 'پاسخ ادمین به بازخورد شما:');
      for (const r of replies) {
        await bot.sendMessage(targetChatId, r);
      }
      // clear
      if (keyFound) adminReplies.delete(keyFound);
      userChats.delete(keyFound);
    }

    await bot.sendMessage(adminId, '✅ پاسخ‌ها به کاربر ارسال شد.');
    return;
  }

  // Otherwise store the admin reply (fallback)
  // find key for this chatId
  let key = null;
  for (const [k, v] of userChats.entries()) {
    if (v === targetChatId) {
      key = k;
      break;
    }
  }
  if (!key) {
    // create a key based on chat id
    key = `id_${targetChatId}`;
    userChats.set(key, targetChatId);
  }

  const arr = adminReplies.get(key) || [];
  arr.push(text);
  adminReplies.set(key, arr);

  await bot.sendMessage(adminId, '✅ پاسخ ذخیره شد. برای ارسال به کاربر، لطفاً "پایان" را ارسال کنید.');
});
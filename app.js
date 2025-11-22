// app.js (cleaned, fixed, safe-restart, proxy-test-before-save)
// Make sure: npm install node-telegram-bot-api socks-proxy-agent mongoose dotenv

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');
const mongoose = require('mongoose');

const token = process.env.TOKEN || null;
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const PROXY_FILE = path.join(__dirname, 'proxy.json');
const MONGO_URI = process.env.MONGO_URI
// Persian messages (exact)
const MSG = Object.freeze({
  PROXY_APPLYING: 'در حال اعمال پروکسی... لطفا صبر کنید',
  PROXY_SET: 'پروکسی با موفقیت ست شد',
  PROXY_REMOVE_STARTED: 'در حال حذف پروکسی و راه‌اندازی مجدد ربات...',
  PROXY_REMOVED: 'پروکسی حذف شد',
  NOT_ALLOWED: 'شما اجازه انجام این کار را ندارید',
  BAD_FORMAT: 'فرمت پروکسی صحیح نیست',
  PROXY_APPLY_ERROR: 'خطا در اعمال پروکسی — لطفاً لاگ‌ها را بررسی کن'
});

// state
let bot = null;
let botUsername = process.env.BOT_USERNAME || null;
let questions = [];
const userStates = new Map(); // chatId -> { state, timeout, ... }
if (!global.adminQuestionReplyBuffer) global.adminQuestionReplyBuffer = new Map();
let restartLock = false;

// --- Mongoose models ---
const questionSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  question: { type: String, required: true },
  answerSite: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Question = mongoose.model('Question', questionSchema);

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

const answerLogSchema = new mongoose.Schema({
  type: { type: String, enum: ['question', 'feedback'], required: true },
  questionId: Number,
  questionText: String,
  userChatId: Number,
  userId: Number,
  username: String,
  userQuestion: String,
  userFeedback: String,
  adminId: String,
  adminUsername: String,
  adminAnswers: [String],
  createdAt: { type: Date, default: Date.now }
});
const AnswerLog = mongoose.model('AnswerLog', answerLogSchema);

const defaultQuestions = require('./db');

// --- DB helpers ---
async function loadQuestions() {
  try {
    const docs = await Question.find().sort({ id: 1 }).lean();
    if (!docs || docs.length === 0) {
      console.log('No questions in DB — loading defaults');
      await Question.insertMany(defaultQuestions);
      questions = await Question.find().sort({ id: 1 }).lean();
    } else {
      questions = docs;
    }
    console.log(`Loaded ${questions.length} questions`);
  } catch (err) {
    console.error('loadQuestions error:', err && err.message ? err.message : err);
    questions = defaultQuestions || [];
  }
}

// --- Proxy file helpers ---
function loadProxyFromFile() {
  try {
    if (!fs.existsSync(PROXY_FILE)) return null;
    const raw = fs.readFileSync(PROXY_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return obj && obj.proxy ? obj.proxy : null;
  } catch (e) {
    console.error('Failed to load proxy file:', e && e.message ? e.message : e);
    return null;
  }
}

function saveProxyToFile(proxy) {
  try {
    fs.writeFileSync(PROXY_FILE, JSON.stringify({ proxy }, null, 2), 'utf8');
    console.log('Saved proxy to', PROXY_FILE);
  } catch (e) {
    console.error('Failed to save proxy file:', e && e.message ? e.message : e);
    throw e;
  }
}

function deleteProxyFile() {
  try {
    if (fs.existsSync(PROXY_FILE)) fs.unlinkSync(PROXY_FILE);
    console.log('Deleted proxy file (if existed):', PROXY_FILE);
  } catch (e) {
    console.error('Failed to delete proxy file:', e && e.message ? e.message : e);
    throw e;
  }
}

// --- Strict socks5 validation ---
function validateSocks5Url(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'socks5:') return false;

    // host may be IPv4 or domain
    const host = u.hostname;
    const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
    const domain = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[A-Za-z]{2,}$/;
    if (!(ipv4.test(host) || domain.test(host))) return false;

    const port = Number(u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;

    // optional credentials allowed (username:password@)
    // rebuild and test with a strict regex
    const creds = u.username ? `${u.username}${u.password ? ':' + u.password : ''}@` : '';
    const rebuilt = `socks5://${creds}${host}:${port}`;
    const strictRe = /^socks5:\/\/(?:[^@\/\s]+@)?(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9\-\.]+):\d{1,5}$/;
    return strictRe.test(rebuilt);
  } catch (e) {
    return false;
  }
}

// --- Utilities ---
async function sendLongMessage(chatId, text, options = {}) {
  try {
    const MAX = 4000;
    if (!text) return;
    if (text.length <= MAX) return await bot.sendMessage(chatId, text, options);
    for (let i = 0; i < text.length; i += MAX) {
      const chunk = text.slice(i, i + MAX);
      await bot.sendMessage(chatId, chunk, options);
      await new Promise(r => setTimeout(r, 150));
    }
  } catch (e) {
    console.error('sendLongMessage error:', e && e.message ? e.message : e);
  }
}

async function sendQuickAnswerList(chatId) {
  try {
    if (!Array.isArray(questions) || questions.length === 0) {
      await bot.sendMessage(chatId, '❗️ در حال حاضر هیچ سوالی موجود نیست.');
      return;
    }
    const ITEMS_PER_MESSAGE = 15;
    const chunks = [];
    let current = '📚 لیست تمام سوالات و پاسخ‌ها:\n\n';
    let counter = 0;
    const usernameForLink = botUsername ? botUsername : '<your_bot_username>';
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      current += `${i + 1}. <a href="https://t.me/questions_islam/${q.id}">${q.question}</a>\n`;
      current += `<a href="${q.answerSite}">پاسخ در سایت</a>\n`;
      current += `<a href="https://t.me/${usernameForLink}?start=feedback_${q.id}">ارسال بازخورد</a>\n\n`;
      counter++;
      if (counter >= ITEMS_PER_MESSAGE) {
        chunks.push(current);
        current = '📚 ادامه لیست سوالات و پاسخ‌ها:\n\n';
        counter = 0;
      }
    }
    if (current.length) chunks.push(current);
    for (const c of chunks) {
      await bot.sendMessage(chatId, c, { parse_mode: 'HTML', disable_web_page_preview: false });
      await new Promise(r => setTimeout(r, 300));
    }
    try { await bot.sendSticker(chatId, 'CAACAgQAAxkBAAIDaWRqhP4v7h8AAUtplwrqAAHMXt5c3wACPxAAAqbxcR4V0yHjRsIKVy8E'); } catch (e) {}
  } catch (e) {
    console.error('sendQuickAnswerList error:', e && e.message ? e.message : e);
  }
}

function cancelQuestionState(chatId) {
  if (userStates.has(chatId)) {
    try { clearTimeout(userStates.get(chatId).timeout); } catch (e) {}
    userStates.delete(chatId);
    return true;
  }
  return false;
}

function startQuestionFlow(chatId, from) {
  if (String(chatId) === String(ADMIN_ID)) return;
  if (userStates.has(chatId)) {
    try { clearTimeout(userStates.get(chatId).timeout); } catch (e) {}
    userStates.delete(chatId);
  }
  const timeout = setTimeout(() => {
    if (userStates.has(chatId)) {
      bot.sendMessage(chatId, '⏳ زمان پرسیدن سوال به پایان رسید. لطفاً دوباره تلاش کنید.');
      cancelQuestionState(chatId);
    }
  }, 5 * 60 * 1000);
  userStates.set(chatId, { state: 'waiting_for_question', userId: from.id, username: from.username || 'بدون نام کاربری', timeout });
  bot.sendMessage(chatId, '📝 لطفاً سوال خود را بنویسید.\n\nبرای لغو از دستور /cancel استفاده کنید.');
}

async function startFeedbackFlowFromDeepLink(chatId, qid) {
  try {
    const q = questions.find(x => String(x.id) === String(qid));
    const username = '';
    const fb = new Feedback({ questionId: Number(qid), questionText: q ? q.question : '', userChatId: chatId, userId: chatId, username, status: 'waiting_for_text' });
    await fb.save();
    const timeout = setTimeout(() => {
      if (userStates.has(chatId) && userStates.get(chatId).state === 'waiting_for_feedback') userStates.delete(chatId);
    }, 5 * 60 * 1000);
    userStates.set(chatId, { state: 'waiting_for_feedback', feedbackId: fb._id, timeout });
    await bot.sendMessage(chatId, `لطفا متن بازخورد برای پست "${q ? q.question : ''}" را بنویسید. پس از ارسال، من آن را برای مدیریت می‌فرستم.`);
  } catch (e) {
    console.error('startFeedbackFlowFromDeepLink error:', e && e.message ? e.message : e);
  }
}

// --- Core: safe restart and bot creation ---
async function createBotWithProxy(proxyUrl) {
  if (restartLock) {
    console.log('createBotWithProxy: restart already in progress, skipping');
    return;
  }
  restartLock = true;
  try {
    console.log('createBotWithProxy: starting (proxy=%s)', proxyUrl);
    // allow current handler to finish sending the "در حال ..." message
    await new Promise(r => setTimeout(r, 250));
    if (bot) {
      try { await bot.stopPolling(); } catch (e) { console.warn('stopPolling failed', e && e.message ? e.message : e); }
      try { bot.removeAllListeners && bot.removeAllListeners(); } catch (e) { console.warn('removeAllListeners failed', e && e.message ? e.message : e); }
      bot = null;
    }

    const options = { polling: true };
    if (proxyUrl) {
      const agent = new SocksProxyAgent(proxyUrl);
      options.request = { agent };
    }

    bot = new TelegramBot(token, options);

    // register handlers (single router + callback_query)
    try {
      bot.on('message', handleMessage);
      bot.on('callback_query', async (callbackQuery) => {
        try {
          const data = callbackQuery.data || '';
          const chatId = callbackQuery.message ? callbackQuery.message.chat.id : (callbackQuery.from && callbackQuery.from.id);
          if (chatId) cancelQuestionState(chatId);

          if (data === 'show_quick_answer') { await sendQuickAnswerList(chatId); await bot.answerCallbackQuery(callbackQuery.id); return; }
          if (data === 'ask_new_question') { if (String(chatId) === String(ADMIN_ID)) { await bot.answerCallbackQuery(callbackQuery.id); return; } startQuestionFlow(chatId, callbackQuery.from); await bot.answerCallbackQuery(callbackQuery.id); return; }
          if (data && data.startsWith('feedback_')) { const qid = data.split('_')[1]; await startFeedbackFlowFromDeepLink(callbackQuery.from.id, qid); await bot.answerCallbackQuery(callbackQuery.id); return; }
          if (data && data.startsWith('feedback:')) { const qid = data.split(':')[1]; const q = questions.find(x => String(x.id) === String(qid)); const user = callbackQuery.from; const feedbackMsg = `📣 درخواست بازخورد از کاربر @${user.username || 'بدون نام کاربری'}:\n\nسوال: ${q ? q.question : 'نامشخص'}\nلینک پست: https://t.me/questions_islam/${qid}\n\nchatId:${callbackQuery.from.id}`; await sendLongMessage(ADMIN_ID, feedbackMsg); await bot.answerCallbackQuery(callbackQuery.id, { text: 'بازخورد برای مدیریت ارسال شد.' }); return; }
        } catch (err) { console.error('callback_query handler error:', err && err.message ? err.message : err); }
      });

      bot.on('polling_error', (err) => { console.error('polling_error:', err && err.message ? err.message : err); });
    } catch (e) {
      console.error('register handlers failed', e && e.message ? e.message : e);
    }

    // ensure bot is usable
    try {
      const info = await bot.getMe();
      botUsername = info && info.username ? info.username : botUsername;
      console.log('Bot username:', botUsername);
    } catch (e) {
      console.warn('Could not get bot username; deep links may not work until available.', e && e.message ? e.message : e);
    }

    console.log('Bot started' + (proxyUrl ? ` with proxy ${proxyUrl}` : ' without proxy'));
  } catch (e) {
    console.error('createBotWithProxy error:', e && e.stack ? e.stack : e);
    throw e;
  } finally {
    restartLock = false;
  }
}

// Helper to test proxy before saving (creates a temporary client and calls getMe)
async function testProxy(proxyUrl) {
  try {
    const agent = new SocksProxyAgent(proxyUrl);
    const tmpBot = new TelegramBot(token, { polling: false, request: { agent } });
    try {
      await tmpBot.getMe();
      return true;
    } finally {
      // tmpBot created with polling:false so no need to stopPolling, but safe guard:
      try { if (tmpBot && tmpBot.stopPolling) await tmpBot.stopPolling(); } catch (e) {}
    }
  } catch (e) {
    console.error('testProxy failed:', e && e.message ? e.message : e);
    return false;
  }
}

// --- Single message router ---
async function handleMessage(msg) {
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const fromId = msg.from ? String(msg.from.id) : '';
  const textRaw = (msg.text || '').trim();
  const text = textRaw;

  // 1) Admin proxy commands
  const addProxyMatch = text.match(/^افزودن پروکسی \((.+)\)$/u);
  if (addProxyMatch) {
    if (String(fromId) !== String(ADMIN_ID)) {
      await bot.sendMessage(chatId, MSG.NOT_ALLOWED);
      return;
    }
    const proxyUrl = addProxyMatch[1].trim();
    if (!validateSocks5Url(proxyUrl)) {
      await bot.sendMessage(chatId, MSG.BAD_FORMAT);
      return;
    }

    // Inform admin and test proxy before persisting
    await bot.sendMessage(chatId, MSG.PROXY_APPLYING);

    const ok = await testProxy(proxyUrl);
    if (!ok) {
      await bot.sendMessage(chatId, MSG.PROXY_APPLY_ERROR);
      return;
    }

    // Persist and restart safely (we use small timeout to let current message flow finish)
    try {
      saveProxyToFile(proxyUrl);
      setTimeout(() => {
        createBotWithProxy(proxyUrl).catch(err => console.error('createBotWithProxy after save failed', err && err.message ? err.message : err));
      }, 200);
      await bot.sendMessage(chatId, MSG.PROXY_SET);
    } catch (e) {
      console.error('Failed to save or restart with proxy:', e && e.message ? e.message : e);
      await bot.sendMessage(chatId, MSG.PROXY_APPLY_ERROR);
    }
    return;
  }

  if (text === 'حذف پروکسی') {
    if (String(fromId) !== String(ADMIN_ID)) {
      await bot.sendMessage(chatId, MSG.NOT_ALLOWED);
      return;
    }
    await bot.sendMessage(chatId, MSG.PROXY_REMOVE_STARTED);
    try {
      deleteProxyFile();
      setTimeout(() => {
        createBotWithProxy(null).catch(err => console.error('createBotWithProxy after delete failed', err && err.message ? err.message : err));
      }, 200);
      await bot.sendMessage(chatId, MSG.PROXY_REMOVED);
    } catch (e) {
      console.error('Failed to delete proxy or restart:', e && e.message ? e.message : e);
      await bot.sendMessage(chatId, MSG.PROXY_APPLY_ERROR);
    }
    return;
  }

  // 2) Command handling
  if (text.startsWith('/')) {
    const cmd = text.split(' ')[0].toLowerCase();
    if (cmd === '/start') {
      const m = text.match(/^\/start(?:\s+(.+))?/i);
      const payload = m && m[1] ? m[1] : null;
      if (!payload || !payload.startsWith('feedback_')) cancelQuestionState(chatId);
      if (payload && payload.startsWith('feedback_')) {
        const qid = payload.split('_')[1];
        const q = questions.find(x => String(x.id) === String(qid));
        const fb = new Feedback({ questionId: Number(qid), questionText: q ? q.question : '', userChatId: msg.from.id, userId: msg.from.id, username: msg.from.username ? `@${msg.from.username}` : '', status: 'waiting_for_text' });
        await fb.save();
        const timeout = setTimeout(() => { if (userStates.has(chatId) && userStates.get(chatId).state === 'waiting_for_feedback') userStates.delete(chatId); }, 5 * 60 * 1000);
        userStates.set(chatId, { state: 'waiting_for_feedback', feedbackId: fb._id, timeout });
        await bot.sendMessage(chatId, `لطفا متن بازخورد برای پست "${q ? q.question : ''}" را بنویسید. پس از ارسال، من آن را برای مدیریت می‌فرستم.`);
        return;
      }

      // welcome
      let welcomeMessage = `🌟 خوش آمدید به ربات پاسخگوی سوالات اسلامی!\n\n🤖 این ربات به شما کمک می‌کند تا:\n- سوالات خود درباره اسلام را بپرسید\n- به پاسخ‌های موجود دسترسی داشته باشید\n- با مطالب آموزنده آشنا شوید\n\n📝 دستورات موجود:\n/start - شروع مجدد ربات\n/quickAnswer - مشاهده لیست تمام سوالات و پاسخ‌ها\n/question - پرسیدن سوال جدید\n/cancel - لغو عملیات فعلی\n\n🔍 نمونه سوالات رندوم:`;
      let randomQuestions = [];
      if (questions && questions.length > 0) { const shuffled = questions.slice().sort(() => 0.5 - Math.random()); randomQuestions = shuffled.slice(0, 3); }
      let questionsMessage = '';
      randomQuestions.forEach(q => { questionsMessage += `❓ <a href="https://t.me/questions_islam/${q.id}">${q.question}</a>\n`; });
      const fullMessage = `${welcomeMessage}\n\n${questionsMessage || '❗️ نمونه سوال در حال حاضر موجود نیست.'}`;
      const keyboard = { reply_markup: { inline_keyboard: [[{ text: 'سوالاتی که قبلا پاسخ داده شده', callback_data: 'show_quick_answer' }, { text: 'پرسیدن سوال جدید', callback_data: 'ask_new_question' }]] }, parse_mode: 'HTML', disable_web_page_preview: false };
      await bot.sendMessage(chatId, fullMessage, keyboard);
      return;
    }
    if (cmd === '/quickanswer') { await sendQuickAnswerList(chatId); return; }
    if (cmd === '/question') { startQuestionFlow(chatId, msg.from); return; }
    if (cmd === '/cancel') { if (cancelQuestionState(chatId)) await bot.sendMessage(chatId, '❌ عملیات لغو شد.'); else await bot.sendMessage(chatId, '❗️ عملیاتی برای لغو کردن وجود ندارد.'); return; }
    return;
  }

if (text === 'سلام') { 
    await bot.sendMessage(chatId, 'و علیکم سلام دوست اهل پرشیا من \n اگه سوالی داری /question رو بزن'); 
    return; 
}

const badWords = ['کیر','کون','کص','کس','dick','sex','porn','pussy','ass'];

function normalizeText(input) {
    return input.toLowerCase();
}

// regex با بررسی مرز کلمه فارسی یا فاصله/شروع/پایان
const badWordsRegex = new RegExp(`(?<![آ-ی])(${badWords.join('|')})(?![آ-ی])`, 'i');

if (badWordsRegex.test(normalizeText(text))) {
    await bot.sendMessage(chatId, 'لطفا از کلمات شرم‌آور استفاده نکنید\nبیایید محترمانه حرف بزنیم تا گفت‌وگو خوشایندتر شود');
    return;
}

  // 4) admin reply-to-user (same logic as before)
  if (String(fromId) === String(ADMIN_ID) && msg.reply_to_message && msg.text) {
    const original = msg.reply_to_message.text || '';
    const feedbackMatch = original.match(/FeedbackID:([0-9a-fA-F]{24})/);
    const textLower = msg.text.trim().toLowerCase();

    if (feedbackMatch) {
      const fbId = feedbackMatch[1];
      if (textLower === 'پایان') {
        const fb = await Feedback.findById(fbId);
        if (fb && fb.adminReplies && fb.adminReplies.length > 0) {
          const previewText = (fb.userFeedback || '').split(' ').slice(0, 5).join(' ') + '...';
          await bot.sendMessage(fb.userChatId, `پاسخ ادمین به بازخورد "${previewText}":`);
          for (const r of fb.adminReplies) await bot.sendMessage(fb.userChatId, r);
          await AnswerLog.create({ type: 'feedback', questionId: fb.questionId, questionText: fb.questionText, userChatId: fb.userChatId, userId: fb.userId, username: fb.username, userFeedback: fb.userFeedback, adminId: ADMIN_ID, adminAnswers: fb.adminReplies, createdAt: new Date() });
          fb.status = 'completed'; fb.adminReplies = []; await fb.save();
          await bot.sendMessage(ADMIN_ID, '✅ پاسخ‌ها به کاربر ارسال شد.');
        } else { await bot.sendMessage(ADMIN_ID, '⚠️ هیچ پاسخی ثبت نشده است.'); }
        return;
      }
      if (msg.text.length < 50) { await bot.sendMessage(ADMIN_ID, '❗️ پاسخ شما باید حداقل ۵۰ کاراکتر باشد. لطفاً پاسخ را با جزئیات بیشتری بنویسید.'); return; }
      await Feedback.findByIdAndUpdate(fbId, { $push: { adminReplies: msg.text }, $set: { status: 'waiting_admin' } });
      await bot.sendMessage(ADMIN_ID, '✅ پاسخ ذخیره شد. برای ارسال به کاربر، لطفاً "پایان" را ارسال کنید.');
      return;
    }

    const chatIdMatch = original.match(/chatId:(\d+)/);
    const questionMatch = original.match(/یک سؤال جدید از کاربر[\s\S]*?\n([\s\S]*?)\n\nchatId:/);
    if (chatIdMatch) {
      const targetChatId = Number(chatIdMatch[1]);
      if (String(targetChatId) === String(ADMIN_ID)) return;
      const bufferKey = msg.reply_to_message.message_id;
      if (!global.adminQuestionReplyBuffer.has(bufferKey)) global.adminQuestionReplyBuffer.set(bufferKey, { replies: [], targetChatId, userQuestion: questionMatch ? questionMatch[1].trim() : '' });
      const buffer = global.adminQuestionReplyBuffer.get(bufferKey);
      if (textLower === 'پایان') {
        if (!buffer) { await bot.sendMessage(ADMIN_ID, '⚠️ پاسخی برای این سوال یافت نشد.'); return; }
        if (buffer.replies.length > 0) {
          const previewText = buffer.userQuestion ? buffer.userQuestion.split(' ').slice(0,5).join(' ') + '...' : '';
          await bot.sendMessage(buffer.targetChatId, `پاسخ ادمین به سوال "${previewText}":`);
          for (const r of buffer.replies) await bot.sendMessage(buffer.targetChatId, r);
          await AnswerLog.create({ type: 'question', userChatId: buffer.targetChatId, userQuestion: buffer.userQuestion, adminId: ADMIN_ID, adminAnswers: buffer.replies, createdAt: new Date() });
          global.adminQuestionReplyBuffer.delete(bufferKey);
          await bot.sendMessage(ADMIN_ID, '✅ پاسخ‌ها به کاربر ارسال شد.');
        } else { await bot.sendMessage(ADMIN_ID, '⚠️ هیچ پاسخی ثبت نشده است.'); }
        return;
      }
      if (msg.text.length < 50) { await bot.sendMessage(ADMIN_ID, '❗️ پاسخ شما باید حداقل ۵۰ کاراکتر باشد. لطفاً پاسخ را با جزئیات بیشتری بنویسید.'); return; }
      buffer.replies.push(msg.text);
      global.adminQuestionReplyBuffer.set(bufferKey, buffer);
      await bot.sendMessage(ADMIN_ID, '✅ پاسخ ذخیره شد. برای ارسال به کاربر، لطفاً "پایان" را ارسال کنید.');
      return;
    }
  }

  // 5) user states (waiting for question/feedback)
  if (userStates.has(chatId)) {
    const state = userStates.get(chatId);
    if (state.state === 'waiting_for_feedback') {
      try {
        const fb = await Feedback.findById(state.feedbackId);
        if (fb) {
          fb.userFeedback = text;
          fb.status = 'waiting_admin';
          await fb.save();
          const adminMsg = `📩 بازخورد جدید از ${fb.username || ''} برای سوال:\n\n${fb.questionText}\n\nمتن بازخورد:\n${text}\n\nFeedbackID:${fb._id}\nchatId:${fb.userChatId}`;
          await sendLongMessage(ADMIN_ID, adminMsg);
          await bot.sendMessage(chatId, '✅ بازخورد شما ثبت و برای مدیریت ارسال شد.');
        }
      } catch (e) { console.error('saving feedback error:', e && e.message ? e.message : e); }
      try { clearTimeout(state.timeout); } catch (e) {}
      userStates.delete(chatId);
      return;
    }
    if (state.state === 'waiting_for_question') {
      if (text.length < 50) { await bot.sendMessage(chatId, '❗️ سوال شما باید حداقل ۵۰ کاراکتر باشد. لطفاً سوال خود را با جزئیات بیشتری بنویسید.'); return; }
      const usernameDisplay = state.username && state.username !== 'بدون نام کاربری' ? `@${state.username}` : '';
      const questionMessage = `📩 یک سؤال جدید از کاربر ${usernameDisplay}\n\n${text}\n\nchatId:${chatId}`;
      await AnswerLog.create({ type: 'question', userChatId: chatId, userId: state.userId, username: state.username, userQuestion: text, createdAt: new Date() });
      await bot.sendMessage(ADMIN_ID, questionMessage);
      await bot.sendMessage(chatId, '✅ سوال شما دریافت شد و به زودی پاسخ داده خواهد شد.');
      try { clearTimeout(state.timeout); } catch (e) {}
      userStates.delete(chatId);
      return;
    }
  }

  // 6) phrase triggers / default
  const normalized = text;
  const validQuestionPhrases = ['سوال دارم', 'یک تضاد پیدا کردم تو اسلام', 'یک مشکل پیدا کردم تو اسلام'];
  if (validQuestionPhrases.includes(normalized)) { startQuestionFlow(chatId, msg.from); return; }

  if (String(fromId) !== String(ADMIN_ID)) {
    await bot.sendMessage(chatId, 'اگر می‌خواهید سوالی بپرسید، لطفاً از دستور /question استفاده کنید یا یکی از عبارات زیر را بنویسید:\n- سوال دارم\n- یک تضاد پیدا کردم تو اسلام\n- یک مشکل پیدا کردم تو اسلام');
  }
}

// --- startup ---
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('Connected to MongoDB questionIslamBot');
    await loadQuestions().catch(err => console.error('loadQuestions error:', err));
    const startupProxy = loadProxyFromFile();
    await createBotWithProxy(startupProxy);
  })
  .catch(err => {
    console.error('MongoDB connect error:', err && err.message ? err.message : err);
    // still try to start bot without DB (fallback)
    loadQuestions().catch(() => {});
    const startupProxy = loadProxyFromFile();
    createBotWithProxy(startupProxy).catch(() => {});
  });

process.on('SIGINT', async () => {
  console.log('SIGINT received — stopping bot');
  try { if (bot) await bot.stopPolling(); } catch (e) {}
  process.exit(0);
});

module.exports = { createBotWithProxy, loadProxyFromFile, saveProxyToFile, deleteProxyFile, validateSocks5Url };

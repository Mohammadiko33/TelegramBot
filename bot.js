require('dotenv').config();
const telegramBot = require('node-telegram-bot-api');
const token = process.env.TOKEN || null;
const adminId = process.env.ADMIN_ID;
const questions = require('./db');

const bot = new telegramBot(token, { polling: true });

// Store user states
const userStates = new Map();

// Store admin replies for each user
const adminReplies = new Map();

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
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Welcome message with bot description and commands
  const welcomeMessage = `🌟 خوش آمدید به ربات پاسخگوی سوالات اسلامی!

🤖 این ربات به شما کمک می‌کند تا:
- سوالات خود درباره اسلام را بپرسید
- به پاسخ‌های موجود دسترسی داشته باشید
- با مطالب آموزنده آشنا شوید

📝 دستورات موجود:
/start - شروع مجدد ربات
/quickAnswer - مشاهده لیست تمام سوالات و پاسخ‌ها
/question - پرسیدن سوال جدید
/cancel - لغو عملیات فعلی

🔍 نمونه سوالات موجود:`;

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
  
  await bot.sendMessage(chatId, '📚 لیست تمام سوالات و پاسخ‌ها:');
  
  for (const q of questions) {
    const message = `<a href="https://t.me/questions_islam/${q.id}">${q.question}</a>\n\n🔍 پاسخ در سایت:\n${q.answerSite}`;
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
  }
  
  await bot.sendMessage(chatId, '📖 برای مطالعه پاسخ‌ها روی لینک‌ها کلیک کنید!');
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
  
  // Check if user is in question state
  if (userStates.has(chatId)) {
    const userState = userStates.get(chatId);
    
    if (userState.state === 'waiting_for_question') {
      // Forward question to admin
      const questionMessage = `📩 یک سؤال جدید از کاربر @${userState.username}:\n\n${text}`;
      await bot.sendMessage(adminId, questionMessage);
      
      await bot.sendMessage(chatId, '✅ سوال شما دریافت شد و به زودی پاسخ داده خواهد شد.');
      
      // Initialize admin replies for this user
      adminReplies.set(userState.username, []);
      
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

// Reply handler for admin
bot.on('message', async (msg) => {
  if (msg.from.id.toString() !== adminId || !msg.reply_to_message) return;
  
  const replyText = msg.text;
  const originalMessage = msg.reply_to_message.text;
  
  // Check if the replied message is a question from a user
  if (originalMessage && originalMessage.startsWith('📩 یک سؤال جدید از کاربر')) {
    // Extract username from the original question
    const usernameMatch = originalMessage.match(/@(\w+):/);
    if (!usernameMatch) return;
    
    const username = usernameMatch[1];
    
    if (replyText.toLowerCase() === 'پایان') {
      // Get all collected replies for this user
      const replies = adminReplies.get(username) || [];
      
      // Find user's chat ID from stored states
      let userChatId;
      for (const [chatId, state] of userStates.entries()) {
        if (state.username === username) {
          userChatId = chatId;
          break;
        }
      }
      
      if (userChatId && replies.length > 0) {
        // Send all replies to the user
        for (const reply of replies) {
          await bot.sendMessage(userChatId, reply);
        }
        
        // Clear stored replies
        adminReplies.delete(username);
      }
      
      await bot.sendMessage(msg.chat.id, '✅ پاسخ‌ها به کاربر ارسال شد.');
    } else {
      // Store the reply
      const userReplies = adminReplies.get(username) || [];
      userReplies.push(replyText);
      adminReplies.set(username, userReplies);
      
      await bot.sendMessage(msg.chat.id, '✅ پاسخ ذخیره شد. برای ارسال به کاربر، لطفاً "پایان" را ارسال کنید.');
    }
  }
});

console.log('Bot is running...');

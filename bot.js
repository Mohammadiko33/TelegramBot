require('dotenv').config();
const telegramBot = require('node-telegram-bot-api');
const token = process.env.TOKEN || null;

const bot = new telegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Welcome! How can I assist you today?');
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(chatId, `You said: ${msg.text}`);
  }
});

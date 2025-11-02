// node .\sync_db_with_dbjs.js
const mongoose = require('mongoose');
const defaultQuestions = require('./db');

async function main() {
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/questionIslamBot', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Connected to MongoDB questionIslamBot');

    const questionSchema = new mongoose.Schema({
      id: { type: Number, required: true, unique: true },
      question: { type: String, required: true },
      answerSite: { type: String, required: true },
      createdAt: { type: Date, default: Date.now }
    });
    const Question = mongoose.model('Question', questionSchema);

    const items = Array.isArray(defaultQuestions) ? defaultQuestions : [];
    if (items.length === 0) {
      console.log('No items found in db.js. Nothing to do.');
      return process.exit(0);
    }

    let inserted = 0;
    let identical = 0;
    let differing = 0;

    for (const item of items) {
      if (typeof item.id === 'undefined') {
        console.log('Skipping an item without id:', item);
        continue;
      }

      const existing = await Question.findOne({ id: item.id }).lean();
      if (!existing) {
        await Question.create({ id: item.id, question: item.question, answerSite: item.answerSite, createdAt: item.createdAt || new Date() });
        console.log(`Inserted new question id=${item.id}`);
        inserted++;
        continue;
      }

      const qExisting = (existing.question || '').trim();
      const aExisting = (existing.answerSite || '').trim();
      const qNew = (item.question || '').trim();
      const aNew = (item.answerSite || '').trim();

      const qSame = qExisting === qNew;
      const aSame = aExisting === aNew;

      if (qSame && aSame) {
        console.log(`No change for id=${item.id}`);
        identical++;
      } else {
        console.log(`Difference for id=${item.id}:`);
        if (!qSame) console.log(`  - question differs\n    DB:    ${qExisting}\n    db.js: ${qNew}`);
        if (!aSame) console.log(`  - answerSite differs\n    DB:    ${aExisting}\n    db.js: ${aNew}`);
        differing++;
      }
    }

    console.log('--- Summary ---');
    console.log(`Inserted: ${inserted}`);
    console.log(`Identical: ${identical}`);
    console.log(`Differing: ${differing}`);
    console.log('Done.');
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    try { await mongoose.disconnect(); } catch (e) {}
  }
}

main();

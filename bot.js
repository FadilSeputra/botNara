require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const db = require('./db');

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.catch((err, ctx) => console.error('bot error', ctx?.updateType, err.message?.slice(0,200)));
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const USE_OLLAMA = process.env.USE_OLLAMA === 'true';

// ponytail: AI generation waterfall: Groq -> Gemini -> Ollama -> fallback text.
async function generateCreativeReply(prompt, fallback) {
  // 1. Groq Cloud
  if (GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'groq/compound-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 800 })
      });
      if (res.ok) {
        const data = await res.json();
        let txt = data.choices?.[0]?.message?.content?.trim() || '';
        txt = txt.replace(/<think>.*?<\/think>/gs,'').replace(/<Think>.*?<\/Think>/gs,'').trim();
        if (txt) return txt;
      } else {
        const e = await res.text().catch(()=> '');
        console.error('Groq fail', res.status, e.slice(0,200));
      }
    } catch (e) { console.error('Groq err', e.message); }
  }
  // 2. Gemini Cloud
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const res = await model.generateContent(prompt);
      const txt = res.response.text().trim();
      if (txt) return txt;
    } catch (e) { console.error('Gemini err', e.message.slice(0,200)); }
  }
  // 3. Ollama Lokal
  if (USE_OLLAMA) {
    try {
      const res = await fetch(OLLAMA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }) });
      if (res.ok) {
        const data = await res.json();
        const txt = data.response.trim();
        if (txt) return txt;
      }
    } catch (e) { console.error('Ollama err', e.message); }
  }
  console.error('AI fallback hit, prompt len', prompt.length);
  return fallback;
}

async function ensureUser(tgId) {
  await db.query(
    'INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING',
    [tgId]
  );
}

async function initDB(){
  try {
    const sql = fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8');
    await db.query(sql);
  } catch(e){ console.error('initDB', e.message.slice(0,120)); }
}
initDB().catch(e => console.error('initDB global fail', e));

// ponytail: simple per-user rate limit. upgrade: sliding window if abused.
const _aiRateMap = new Map();
function aiRateLimited(userId) {
  const now = Date.now();
  const last = _aiRateMap.get(userId) || 0;
  if (now - last < 3000) return true; // 3s cooldown per user
  _aiRateMap.set(userId, now);
  return false;
}

function parseParts(text) {
  return text.trim().split(/\s+/).slice(1);
}

function parseAmount(val) {
  if (!val) return null;
  const lower = val.toLowerCase().trim();
  // detect jt/juta (million) and rb/ribu (thousand) before stripping
  if (/[\d.,]+\s*jt/i.test(lower) || /[\d.,]+\s*juta/i.test(lower)) {
    const numStr = lower.replace(/jt.*|juta.*/i, '').replace(/[^\d.]/g, '');
    const num = parseFloat(numStr);
    return num ? Math.round(num * 1000000) : null;
  }
  if (/[\d.,]+\s*rb/i.test(lower) || /[\d.,]+\s*ribu/i.test(lower)) {
    const numStr = lower.replace(/rb.*|ribu.*/i, '').replace(/[^\d.]/g, '');
    const num = parseFloat(numStr);
    return num ? Math.round(num * 1000) : null;
  }
  const clean = lower.replace(/[,.]/g, '').replace(/[^0-9k]/g, '');
  if (!clean) return null;
  if (clean.endsWith('k')) return Number(clean.slice(0, -1)) * 1000;
  return Number(clean);
}

function formatRp(num) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num || 0);
}

async function getStreak(tgId) {
  const res = await db.query('SELECT log_date FROM skill_logs WHERE user_id=$1 ORDER BY log_date DESC', [tgId]);
  if (!res.rows.length) return 0;
  let streak = 0;
  // use WIB date (UTC+7)
  let today = new Date(Date.now() + 7*3600*1000);
  today = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  // allow streak to start from today or yesterday (if today not yet logged)
  let anchor = today;
  const firstLog = new Date(res.rows[0].log_date);
  const firstUTC = new Date(Date.UTC(firstLog.getUTCFullYear(), firstLog.getUTCMonth(), firstLog.getUTCDate()));
  const gapFirst = Math.round((today - firstUTC)/86400000);
  if (gapFirst === 1) anchor = new Date(today - 86400000); // yesterday = start
  else if (gapFirst > 1) return 0;
  for (let i=0;i<res.rows.length;i++) {
    const ld = new Date(res.rows[i].log_date);
    const ldUTC = new Date(Date.UTC(ld.getUTCFullYear(), ld.getUTCMonth(), ld.getUTCDate()));
    const diff = Math.round((anchor - ldUTC)/86400000) - streak;
    if (diff===0) streak++;
    else break;
  }
  return streak;
}

function getWIBNow() {
  const now = new Date(Date.now() + 7*3600*1000);
  return { h: now.getUTCHours(), m: now.getUTCMinutes(), dateStr: now.toISOString().slice(0,10) };
}

async function generateRoadmapWithAI(topic, days) {
  const prompt = `Buat roadmap belajar "${topic}" selama ${days} hari. Output HANYA JSON array valid, tanpa markdown. Format: [{"day":1,"title":"...","task":"..."}, ...]. Tiap task 1 kalimat jelas dan actionable untuk pemula.`;
  // try Groq directly with bigger tokens
  const GROQ = process.env.GROQ_API_KEY;
  if (GROQ) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST', headers:{'Authorization':'Bearer '+GROQ,'Content-Type':'application/json'},
        body: JSON.stringify({ model:'groq/compound-mini', messages:[{role:'user', content: prompt}], temperature:0.6, max_tokens:4000 })
      });
      if (r.ok) {
        let txt = (await r.json()).choices?.[0]?.message?.content?.trim() || '';
        txt = txt.replace(/<think>.*?<\/think>/gs,'').replace(/<Think>.*?<\/Think>/gs,'').trim();
        txt = txt.replace(/```json|```/g,'').trim();
        const arr = JSON.parse(txt);
        if (Array.isArray(arr) && arr.length) return arr.slice(0, days).map((x,i)=>({ day: x.day||i+1, title: x.title||`Hari ${i+1}`, task: x.task||x.description||x.title||'' }));
      }
    } catch(e){ console.error('roadmap AI err', e.message.slice(0,200)); }
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI2 = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const m = genAI2.getGenerativeModel({ model:'gemini-2.0-flash' });
      const res = await m.generateContent(prompt);
      let txt = res.response.text().trim().replace(/```json|```/g,'').trim();
      const arr = JSON.parse(txt);
      if (Array.isArray(arr) && arr.length) return arr.slice(0,days).map((x,i)=>({ day: x.day||i+1, title: x.title||`Hari ${i+1}`, task: x.task||x.description||'' }));
    } catch(e){ console.error('roadmap gemini err', e.message.slice(0,200)); }
  }
  // fallback generic
  return Array.from({length: days}, (_,i)=>({ day:i+1, title: `${topic} - Hari ${i+1}`, task: `Pelajari dan praktekkan ${topic} materi hari ${i+1} (30-60 menit), catat di /skill_log` }));
}

async function sendRoadmapReminders() {
  const { h, m, dateStr } = getWIBNow();
  if (h !== 9 || m > 1) return;
  if (sendRoadmapReminders._lastDate === dateStr) return;
  sendRoadmapReminders._lastDate = dateStr;
  const active = await db.query("SELECT r.id, r.user_id, r.topic, r.current_day, r.total_days, d.title, d.description FROM roadmaps r JOIN roadmap_days d ON d.roadmap_id=r.id AND d.day_number=r.current_day WHERE r.is_active=true AND d.is_done=false");
  for (const row of active.rows) {
    await bot.telegram.sendMessage(row.user_id,
      `\uD83D\uDDFA Roadmap ${row.topic} - Hari ${row.current_day}/${row.total_days}\n📌 ${row.title}\n${row.description}\n\nSudah selesai hari ini? Klik Done atau /roadmap_done`,
      Markup.inlineKeyboard([[Markup.button.callback('\u2705 Done hari ini', `rm_done:${row.id}:${row.current_day}`), Markup.button.callback('Lihat roadmap', 'rm_status')]])
    ).catch(()=>{});
  }
}

async function sendSkillReminders() {
  const { h, m, dateStr } = getWIBNow();
  if (h !== 9 || m !== 0) return;
  if (sendSkillReminders._lastDate === dateStr) return;
  sendSkillReminders._lastDate = dateStr;
  const users = await db.query('SELECT telegram_id FROM users');
  for (const u of users.rows) {
    const logged = await db.query('SELECT 1 FROM skill_logs WHERE user_id=$1 AND log_date=$2::date', [u.telegram_id, dateStr]);
    if (logged.rows.length) continue;
    const streak = await getStreak(u.telegram_id);
    const streakTxt = streak ? `\n\uD83D\uDD25 Streak: ${streak} hari` : '\nMulai streak hari ini!';
    await bot.telegram.sendMessage(u.telegram_id,
      `\u23F0 Reminder skill 09:00 WIB${streakTxt}\nApa yang mau kamu upgrade hari ini?\nKirim: /skill_log <apa yang dipelajari>`, 
      Markup.inlineKeyboard([[Markup.button.callback('Skip hari ini', 'skill_skip')]])
    ).catch(()=>{});
  }
}

function parseReminderInput(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date;
}

function buildActivityKeyboard(id) {
  return Markup.inlineKeyboard([
    Markup.button.callback('Done', `done:${id}`),
    Markup.button.callback('Hapus', `del_act:${id}`),
  ]);
}

function buildTxKeyboard(id) {
  return Markup.inlineKeyboard([
    Markup.button.callback('Hapus', `del_tx:${id}`),
  ]);
}

async function sendPendingReminders() {
  const result = await db.query(
    `SELECT id, user_id, category, description
     FROM activities
     WHERE is_done=false
       AND remind_at IS NOT NULL
       AND remind_at <= NOW()`
  );

  for (const row of result.rows) {
    try {
      await bot.telegram.sendMessage(
        row.user_id,
        `⏰ Reminder:\n[${row.category}] ${row.description}`,
        buildActivityKeyboard(row.id)
      );
    } catch(e) { console.error('reminder send', row.id, e.message?.slice(0,80)); }
    await db.query('UPDATE activities SET remind_at=NULL WHERE id=$1', [row.id]);
  }
}

setInterval(() => {
  sendPendingReminders().catch(() => {});
}, 30000);
setInterval(() => { sendSkillReminders().catch(()=>{}); }, 60000);
setInterval(() => { sendRoadmapReminders().catch(()=>{}); }, 60000);
setInterval(() => { sendStockAlerts().catch(()=>{}); }, 60000);

async function sendSummary(ctx) {
  const tgId = ctx.from.id;
  const parts = parseParts(ctx.message.text);
  const monthFilter = parts[0]; // optional: "bulan" or "2026-09" etc.
  let dateClause = '', dateParams = [tgId];
  if (monthFilter) {
    // support: /summary bulan (current month WIB) or /summary 2026-09
    let ym;
    if (/^\d{4}-\d{2}$/.test(monthFilter)) ym = monthFilter;
    else { const w = getWIBNow(); ym = w.dateStr.slice(0,7); }
    dateClause = " AND created_at >= $2::date AND created_at < ($2::date + interval '1 month')";
    dateParams.push(ym + '-01');
  }
  const income = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id=$1 AND type='income'${dateClause}`,
    dateParams
  );
  const expense = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id=$1 AND type='expense'${dateClause}`,
    dateParams
  );
  const pending = await db.query(
    'SELECT COUNT(*)::int AS total FROM activities WHERE user_id=$1 AND is_done=false',
    [tgId]
  );

  const inc = Number(income.rows[0].total);
  const exp = Number(expense.rows[0].total);
  const pend = Number(pending.rows[0].total);
  const period = monthFilter ? ` (${dateParams[1]?.slice(0,7) || 'bulan ini'})` : ' (all-time)';

  const defaultMsg = `📊 Summary${period}:\n💰 Income: ${formatRp(inc)}\n💸 Expense: ${formatRp(exp)}\n💵 Saldo: ${formatRp(inc - exp)}\n📌 Pending activity: ${pend}`;
  const creativeMsg = await generateCreativeReply(
    `Buatkan ringkasan keuangan dan aktivitas santai dan seru untuk user dalam Bahasa Indonesia. Periode: ${period}. Pemasukan: ${formatRp(inc)}, Pengeluaran: ${formatRp(exp)}, Saldo: ${formatRp(inc-exp)}, Pending aktivitas: ${pend}. Maksimal 3 kalimat.`,
    defaultMsg
  );

  await ctx.reply(creativeMsg);
}

bot.start(async (ctx) => {
  await ensureUser(ctx.from.id);
  await ctx.reply(
    '✅ Nara-Bot aktif — Personal Assistant\n\n📅 Quick: /today\n📝 Aktivitas: /activity /activities /finish /edit_act\n💰 Keuangan: /income /expense /transactions /summary [bulan] /export\n🧠 Skill: /skill_log /streak /skill_logs (reminder 09:00 WIB)\n🗺️ Roadmap: /roadmap <topik> [hari] /roadmap_done /roadmap_status\n📈 Saham LIVE: /stock BBCA[.JK] (Wyckoff+RSI+SMA+corporate) — jangan pakai /ask untuk saham\n👀 Watch: /watch /unwatch /watchlist /scan (alert 15:35 WIB)\n💬 AI: /ask <pertanyaan keuangan/skill>\n❓ /help untuk detail',
    Markup.keyboard([
      ['/today', '/skill_log', '/streak'],
      ['/summary', '/activities', '/stock'],
      ['/income', '/expense', '/help'],
    ]).resize()
  );
});

bot.command('activity', async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const category = parts[0];
  const reminder = parseReminderInput(parts.at(-1)?.startsWith('at:') ? parts.at(-1).slice(3) : null);
  const descriptionParts = reminder ? parts.slice(1, -1) : parts.slice(1);
  const description = descriptionParts.join(' ');
  if (!category || !description) {
    return ctx.reply('Format: /activity <kategori> <deskripsi> [at:2026-09-02T20:00:00]');
  }
  await ensureUser(ctx.from.id);
  const result = await db.query(
    'INSERT INTO activities (user_id, category, description, remind_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [ctx.from.id, category, description, reminder]
  );
  
  const fallback = `Activity tersimpan: [${category}] ${description}`;
  const msg = await generateCreativeReply(
    `Berikan respon semangat/kreatif 1 kalimat pendek dalam Bahasa Indonesia karena user baru mencatat aktivitas ini: ${description} (kategori: ${category}).`,
    fallback
  );
  await ctx.reply(msg, buildActivityKeyboard(result.rows[0].id));
});

bot.action(/^done:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await db.query('UPDATE activities SET is_done=true WHERE id=$1 AND user_id=$2', [id, ctx.from.id]);
  await ctx.answerCbQuery('Selesai! 🎉');
  await ctx.editMessageReplyMarkup(undefined);
});

bot.action(/^del_act:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await db.query('DELETE FROM activities WHERE id=$1 AND user_id=$2', [id, ctx.from.id]);
  await ctx.answerCbQuery('Aktivitas dihapus');
  await ctx.deleteMessage().catch(() => {});
});

bot.action(/^del_tx:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await db.query('DELETE FROM transactions WHERE id=$1 AND user_id=$2', [id, ctx.from.id]);
  await ctx.answerCbQuery('Transaksi dihapus');
  await ctx.deleteMessage().catch(() => {});
});

bot.command('finish', async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const id = Number(parts[0]);
  const achievement = parts.slice(1).join(' ');
  if (!id || !achievement) return ctx.reply('Format: /finish <activity_id> <achievement>');
  await db.query(
    'UPDATE activities SET is_done=true, achievement=$1 WHERE id=$2 AND user_id=$3',
    [achievement, id, ctx.from.id]
  );
  const fallback = 'Activity selesai dicatat! Selamat!';
  const msg = await generateCreativeReply(
    `Berikan ucapan selamat singkat & gokil 1 kalimat Bahasa Indonesia karena user berhasil menyelesaikan aktivitas dengan pencapaian: ${achievement}.`,
    fallback
  );
  await ctx.reply(msg);
});

bot.command('edit_act', async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const id = Number(parts[0]);
  const category = parts[1];
  const description = parts.slice(2).join(' ');
  if (!id || !category || !description) return ctx.reply('Format: /edit_act <id> <kategori_baru> <deskripsi_baru>');
  
  const res = await db.query(
    'UPDATE activities SET category=$1, description=$2 WHERE id=$3 AND user_id=$4 RETURNING id',
    [category, description, id, ctx.from.id]
  );
  if (!res.rowCount) return ctx.reply('Aktivitas tidak ditemukan');
  await ctx.reply(`Aktivitas #${id} berhasil diubah jadi: [${category}] ${description}`);
});

bot.command('income', async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const amount = parseAmount(parts[0]);
  const category = parts[1];
  const description = parts.slice(2).join(' ');
  if (!amount || !category) return ctx.reply('Format: /income <jumlah> <kategori> <deskripsi?>');
  await ensureUser(ctx.from.id);
  const res = await db.query(
    "INSERT INTO transactions (user_id, type, amount, category, description) VALUES ($1, 'income', $2, $3, $4) RETURNING id",
    [ctx.from.id, amount, category, description || null]
  );

  const formatted = formatRp(amount);
  const fallback = `Mantap! Pemasukan tersimpan: ${formatted} (${category})`;
  const msg = await generateCreativeReply(
    `Buatkan respon gembira & kreatif 1 kalimat Bahasa Indonesia untuk pemasukan sebesar ${formatted} kategori ${category}.`,
    fallback
  );
  await ctx.reply(msg, buildTxKeyboard(res.rows[0].id));
});

bot.command('expense', async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const amount = parseAmount(parts[0]);
  const category = parts[1];
  const description = parts.slice(2).join(' ');
  if (!amount || !category) return ctx.reply('Format: /expense <jumlah> <kategori> <deskripsi?>');
  await ensureUser(ctx.from.id);
  const res = await db.query(
    "INSERT INTO transactions (user_id, type, amount, category, description) VALUES ($1, 'expense', $2, $3, $4) RETURNING id",
    [ctx.from.id, amount, category, description || null]
  );

  const formatted = formatRp(amount);
  const fallback = `Pengeluaran dicatat: ${formatted} untuk ${category}`;
  const msg = await generateCreativeReply(
    `Buatkan respon lucu/kreatif 1 kalimat Bahasa Indonesia tentang pengeluaran uang sebesar ${formatted} untuk ${category}.`,
    fallback
  );
  await ctx.reply(msg, buildTxKeyboard(res.rows[0].id));
});

bot.command('edit_tx', async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const id = Number(parts[0]);
  const amount = parseAmount(parts[1]);
  const category = parts[2];
  const description = parts.slice(3).join(' ');
  if (!id || !amount || !category) return ctx.reply('Format: /edit_tx <id> <jumlah_baru> <kategori_baru> <deskripsi_baru?>');

  const res = await db.query(
    'UPDATE transactions SET amount=$1, category=$2, description=$3 WHERE id=$4 AND user_id=$5 RETURNING id',
    [amount, category, description || null, id, ctx.from.id]
  );
  if (!res.rowCount) return ctx.reply('Transaksi tidak ditemukan');
  await ctx.reply(`Transaksi #${id} diupdate jadi: ${formatRp(amount)} [${category}]`);
});

bot.command(['delete_tx', 'del_tx'], async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const id = Number(parts[0]);
  if (!id) return ctx.reply('Format: /delete_tx <id>');
  const res = await db.query('DELETE FROM transactions WHERE id=$1 AND user_id=$2 RETURNING id', [id, ctx.from.id]);
  if (!res.rowCount) return ctx.reply('Transaksi tidak ditemukan');
  await ctx.reply(`Transaksi #${id} berhasil dihapus`);
});

bot.command(['delete_act', 'del_act'], async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const id = Number(parts[0]);
  if (!id) return ctx.reply('Format: /delete_act <id>');
  const res = await db.query('DELETE FROM activities WHERE id=$1 AND user_id=$2 RETURNING id', [id, ctx.from.id]);
  if (!res.rowCount) return ctx.reply('Aktivitas tidak ditemukan');
  await ctx.reply(`Aktivitas #${id} berhasil dihapus`);
});

bot.command(['transactions', 'transaction'], async (ctx) => {
  const result = await db.query(
    'SELECT id, type, amount, category, description, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',
    [ctx.from.id]
  );
  if (!result.rows.length) return ctx.reply('Belum ada transaksi');
  
  for (const r of result.rows) {
    const icon = r.type === 'income' ? '💰' : '💸';
    const dateStr = new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const text = `${icon} #${r.id} ${r.type.toUpperCase()}: ${formatRp(r.amount)}\n📅 ${dateStr}\nKategori: ${r.category}${r.description ? ` (${r.description})` : ''}`;
    await ctx.reply(text, buildTxKeyboard(r.id));
  }
});

bot.command(['activities', 'activity_list'], async (ctx) => {
  const result = await db.query(
    'SELECT id, category, description, is_done, created_at FROM activities WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',
    [ctx.from.id]
  );
  if (!result.rows.length) return ctx.reply('Belum ada activity');

  for (const r of result.rows) {
    const status = r.is_done ? '✅ Done' : '📌 Pending';
    const dateStr = new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const text = `#${r.id} [${status}]\n📅 ${dateStr}\n${r.category} - ${r.description}`;
    await ctx.reply(text, buildActivityKeyboard(r.id));
  }
});

bot.command('ask', async (ctx) => {
  const parts = parseParts(ctx.message.text);
  const prompt = parts.join(' ');
  if (!prompt) return ctx.reply('Format: /ask <pertanyaan kamu>');
  if (aiRateLimited(ctx.from.id)) return ctx.reply('Sabar, 3 detik antar /ask ya.');
  
  await ctx.replyWithChatAction('typing');

  // Load user data context from DB
  const tgId = ctx.from.id;
  const txResult = await db.query(
    'SELECT type, category, amount, description, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
    [tgId]
  );
  const actResult = await db.query(
    'SELECT category, description, achievement, is_done, remind_at FROM activities WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
    [tgId]
  );
  const aggIncome = await db.query("SELECT category, SUM(amount)::bigint AS total, COUNT(*)::int AS cnt FROM transactions WHERE user_id=$1 AND type='income' GROUP BY category ORDER BY total DESC", [tgId]);
  const aggExpense = await db.query("SELECT category, SUM(amount)::bigint AS total, COUNT(*)::int AS cnt FROM transactions WHERE user_id=$1 AND type='expense' GROUP BY category ORDER BY total DESC", [tgId]);
  const skillRes = await db.query('SELECT content, log_date FROM skill_logs WHERE user_id=$1 ORDER BY log_date DESC LIMIT 10', [tgId]);
  const streak = await getStreak(tgId);

  const lower = prompt.toLowerCase();
  const isSahamQuery = /\b(saham|stock|cuan|wyckoff|corporate|idx|ticker|bbca|bbri|tlkm|goto|antam|bmit)\b/i.test(lower);
  if (isSahamQuery) {
    return ctx.reply(`Untuk analisa saham langsung pakai /stock ya, bukan /ask.\n\nFormat: /stock <ticker>\nContoh: /stock BBCA  atau  /stock BBCA.JK TLKM.JK\n\nHasil: harga live, SMA5/20, RSI14, Wyckoff Phase (Akumulasi/Distribusi/Markup/Markdown), corporate action, bukan advice AI ngarang.\nCoba sekarang: /stock BBCA`);
  }
  const contextStr = `Transaksi 20 terakhir:\n${JSON.stringify(txResult.rows)}\n\nAgregat Income per kategori:\n${JSON.stringify(aggIncome.rows)}\nAgregat Expense per kategori:\n${JSON.stringify(aggExpense.rows)}\n\nAktivitas 20 terakhir:\n${JSON.stringify(actResult.rows)}\n\nSkill logs 10 terakhir (streak ${streak} hari):\n${JSON.stringify(skillRes.rows)}`;
  const fullPrompt = `Kamu Nara-Bot, asisten pribadi Nara (fresh graduate). Role: teman produktif, bukan robot formal.\nAturan:\n- Jawab Bahasa Indonesia santai.\n- Format uang pakai IDR (Rp).\n- Jika data tidak ada di konteks, bilang "data belum ada" jangan ngarang angka.\n- Jika ditanya ringkasan, pakai agregat per kategori + streak.\n- Maksimal 5 kalimat, actionable.\n\nKonteks Data User:\n${contextStr}\n\nPertanyaan User: ${prompt}`;
  const reply = await generateCreativeReply(
    fullPrompt,
    `AI lagi offline. Pertanyaan lu: "${prompt.slice(0,120)}". Coba lagi nanti. Sementara catat target kubernetes via /skill_log kubernetes: <materi hari ini>.`
  );
  await ctx.reply(reply);
});

bot.command('skill_log', async (ctx) => {
  const content = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!content) return ctx.reply('Format: /skill_log <apa yang kamu pelajari hari ini>');
  await ensureUser(ctx.from.id);
  await db.query(
    'INSERT INTO skill_logs (user_id, content) VALUES ($1,$2) ON CONFLICT (user_id, log_date) DO UPDATE SET content=EXCLUDED.content',
    [ctx.from.id, content]
  );
  const streak = await getStreak(ctx.from.id);
  const totalRes = await db.query('SELECT COUNT(*)::int AS c FROM skill_logs WHERE user_id=$1', [ctx.from.id]);
  const total = totalRes.rows[0].c;
  const msg = await generateCreativeReply(
    `User baru log skill: "${content}". Streak ${streak} hari, total ${total} hari. Beri respon penyemangat 1-2 kalimat Bahasa Indonesia dengan mention streak.`,
    `\u2705 Skill hari ini tersimpan: ${content}\n\uD83D\uDD25 Streak: ${streak} hari | Total: ${total} hari`
  );
  await ctx.reply(msg);
});

bot.command(['streak','skill_streak'], async (ctx) => {
  const streak = await getStreak(ctx.from.id);
  const totalRes = await db.query('SELECT COUNT(*)::int AS c FROM skill_logs WHERE user_id=$1', [ctx.from.id]);
  const total = totalRes.rows[0].c;
  const lastRes = await db.query('SELECT content, log_date FROM skill_logs WHERE user_id=$1 ORDER BY log_date DESC LIMIT 1', [ctx.from.id]);
  const last = lastRes.rows[0];
  const lastTxt = last ? `Terakhir (${new Date(last.log_date).toLocaleDateString('id-ID')}): ${last.content}` : 'Belum ada log';
  await ctx.reply(`\uD83D\uDD25 Streak: ${streak} hari\n\uD83D\uDCC5 Total hari belajar: ${total}\n${lastTxt}`);
});

bot.command(['skill_logs','skills'], async (ctx) => {
  const res = await db.query('SELECT content, log_date FROM skill_logs WHERE user_id=$1 ORDER BY log_date DESC LIMIT 10', [ctx.from.id]);
  if (!res.rows.length) return ctx.reply('Belum ada skill log. Mulai dengan /skill_log <materi>');
  let out = '\uD83D\uDCCB 10 log terakhir:\n';
  for (const r of res.rows) out += `\u2022 ${new Date(r.log_date).toLocaleDateString('id-ID')}: ${r.content}\n`;
  await ctx.reply(out);
});

bot.action('skill_skip', async (ctx) => {
  await ctx.answerCbQuery('Oke, besok jangan skip lagi ya!');
  await ctx.editMessageReplyMarkup(undefined).catch(()=>{});
});

bot.command('roadmap', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  if (!args.length) return ctx.reply('Format: /roadmap <topik> [jumlah_hari]\nContoh: /roadmap kubernetes 30  atau  /roadmap docker 7');
  let days = 30;
  const last = args[args.length-1];
  if (/^\d+$/.test(last)) { days = Math.min(60, Math.max(1, parseInt(last,10))); args.pop(); }
  const topic = args.join(' ').trim();
  if (!topic) return ctx.reply('Topik kosong');
  await ensureUser(ctx.from.id);
  const exist = await db.query('SELECT id FROM roadmaps WHERE user_id=$1 AND is_active=true', [ctx.from.id]);
  if (exist.rows.length) return ctx.reply('Masih ada roadmap aktif. Selesaikan atau /roadmap_stop dulu.');
  await ctx.reply(`Membuat roadmap "${topic}" ${days} hari... (AI generate)`);
  const items = await generateRoadmapWithAI(topic, days);
  const rm = await db.query('INSERT INTO roadmaps (user_id, topic, total_days) VALUES ($1,$2,$3) RETURNING id', [ctx.from.id, topic, days]);
  const rmId = rm.rows[0].id;
  for (const it of items) {
    await db.query('INSERT INTO roadmap_days (roadmap_id, day_number, title, description) VALUES ($1,$2,$3,$4)', [rmId, it.day, it.title, it.task]);
  }
  const first = items[0];
  await ctx.reply(`\u2705 Roadmap "${topic}" ${days} hari siap!\n\nHari 1: ${first.title}\n${first.task}\n\nReminder tiap 09:01 WIB. Selesai? /roadmap_done atau klik Done.\nLihat: /roadmap_status`, Markup.inlineKeyboard([[Markup.button.callback('\u2705 Done hari 1', `rm_done:${rmId}:1`)]]));
});

bot.command(['roadmap_done','done','selesai'], async (ctx) => {
  const r = await db.query('SELECT id, topic, current_day, total_days FROM roadmaps WHERE user_id=$1 AND is_active=true ORDER BY id DESC LIMIT 1', [ctx.from.id]);
  if (!r.rows.length) return ctx.reply('Tidak ada roadmap aktif. Buat dengan /roadmap <topik> [hari]');
  const rm = r.rows[0];
  const dayRow = await db.query('SELECT is_done FROM roadmap_days WHERE roadmap_id=$1 AND day_number=$2', [rm.id, rm.current_day]);
  if (!dayRow.rows.length) return ctx.reply('Data hari tidak ditemukan');
  if (dayRow.rows[0].is_done) return ctx.reply(`Hari ${rm.current_day} sudah done. Besok lanjut hari ${rm.current_day+1}`);
  await db.query('UPDATE roadmap_days SET is_done=true, completed_at=NOW() WHERE roadmap_id=$1 AND day_number=$2', [rm.id, rm.current_day]);
  // also log to skill_logs as achievement
  await db.query("INSERT INTO skill_logs (user_id, content) VALUES ($1,$2) ON CONFLICT (user_id, log_date) DO UPDATE SET content = skill_logs.content || ' | ' || EXCLUDED.content", [ctx.from.id, `[Roadmap ${rm.topic} H${rm.current_day}] done`]).catch(()=>{});
  if (rm.current_day >= rm.total_days) {
    await db.query('UPDATE roadmaps SET is_active=false WHERE id=$1', [rm.id]);
    const streak = await getStreak(ctx.from.id);
    const msg = await generateCreativeReply(`User selesaikan roadmap ${rm.topic} ${rm.total_days} hari full. Streak ${streak} hari. Beri ucapan selamat meriah 2 kalimat Bahasa Indonesia.`, `\uD83C\uDF89 Roadmap "${rm.topic}" ${rm.total_days} hari SELESAI! Streak ${streak} hari. Keren Nara!`);
    return ctx.reply(msg);
  }
  const nextDay = rm.current_day + 1;
  await db.query('UPDATE roadmaps SET current_day=$1 WHERE id=$2', [nextDay, rm.id]);
  const next = await db.query('SELECT title, description FROM roadmap_days WHERE roadmap_id=$1 AND day_number=$2', [rm.id, nextDay]);
  const streak = await getStreak(ctx.from.id);
  const fallback = `\u2705 Hari ${rm.current_day} selesai! \uD83D\uDD25 Streak ${streak} hari\nBesok Hari ${nextDay}/${rm.total_days}: ${next.rows[0].title}\n${next.rows[0].description}\nReminder besok 09:01 WIB`;
  const msg = await generateCreativeReply(`User selesai hari ${rm.current_day} roadmap ${rm.topic}. Streak ${streak}. Besok hari ${nextDay}: ${next.rows[0].title} - ${next.rows[0].description}. Beri semangat 1-2 kalimat + sebut besok.`, fallback);
  await ctx.reply(msg, Markup.inlineKeyboard([[Markup.button.callback('\u2705 Done hari '+nextDay, `rm_done:${rm.id}:${nextDay}`)]]));
});

bot.command(['roadmap_status','roadmap_list'], async (ctx) => {
  const r = await db.query('SELECT id, topic, current_day, total_days, is_active FROM roadmaps WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [ctx.from.id]);
  if (!r.rows.length) return ctx.reply('Belum ada roadmap. Buat: /roadmap <topik> [hari]');
  const rm = r.rows[0];
  const doneCnt = await db.query('SELECT COUNT(*)::int AS c FROM roadmap_days WHERE roadmap_id=$1 AND is_done=true', [rm.id]);
  const rows = await db.query('SELECT day_number, title, is_done FROM roadmap_days WHERE roadmap_id=$1 ORDER BY day_number', [rm.id]);
  let out = `${rm.is_active ? '\uD83D\uDDFA' : '\u2705'} Roadmap: ${rm.topic} (${doneCnt.rows[0].c}/${rm.total_days}) ${rm.is_active ? 'Hari '+rm.current_day : 'SELESAI'}\n`;
  for (const row of rows.rows) out += `${row.is_done ? '\u2705' : (row.day_number===rm.current_day && rm.is_active ? '\u25B6\uFE0F' : '\u2B1C')} H${row.day_number}: ${row.title}\n`;
  await ctx.reply(out);
});

bot.command('roadmap_stop', async (ctx) => {
  const r = await db.query('UPDATE roadmaps SET is_active=false WHERE user_id=$1 AND is_active=true RETURNING id', [ctx.from.id]);
  if (!r.rowCount) return ctx.reply('Tidak ada roadmap aktif');
  await ctx.reply('Roadmap dihentikan.');
});

bot.action(/^rm_done:(\d+):(\d+)$/, async (ctx) => {
  const rmId = Number(ctx.match[1]); const day = Number(ctx.match[2]);
  const rm = await db.query('SELECT user_id, current_day, topic, total_days, is_active FROM roadmaps WHERE id=$1', [rmId]);
  if (!rm.rows.length || rm.rows[0].user_id !== ctx.from.id) return ctx.answerCbQuery('Bukan roadmap lu');
  if (!rm.rows[0].is_active) return ctx.answerCbQuery('Roadmap sudah selesai');
  if (day !== rm.rows[0].current_day) return ctx.answerCbQuery(`Sekarang hari ${rm.rows[0].current_day}, bukan ${day}`);
  await db.query('UPDATE roadmap_days SET is_done=true, completed_at=NOW() WHERE roadmap_id=$1 AND day_number=$2', [rmId, day]);
  await db.query("INSERT INTO skill_logs (user_id, content) VALUES ($1,$2) ON CONFLICT (user_id, log_date) DO UPDATE SET content = skill_logs.content || ' | ' || EXCLUDED.content", [ctx.from.id, `[Roadmap ${rm.rows[0].topic} H${day}] done`]).catch(()=>{});
  if (day >= rm.rows[0].total_days) {
    await db.query('UPDATE roadmaps SET is_active=false WHERE id=$1', [rmId]);
    await ctx.answerCbQuery('Roadmap SELESAI!');
    return ctx.editMessageText(`\uD83C\uDF89 Roadmap "${rm.rows[0].topic}" selesai ${day} hari!`).catch(()=>{});
  }
  await db.query('UPDATE roadmaps SET current_day=$1 WHERE id=$2', [day+1, rmId]);
  await ctx.answerCbQuery(`Hari ${day} done! Lanjut hari ${day+1}`);
  await ctx.editMessageReplyMarkup(undefined).catch(()=>{});
  const next = await db.query('SELECT title, description FROM roadmap_days WHERE roadmap_id=$1 AND day_number=$2', [rmId, day+1]);
  if (next.rows.length) await ctx.reply(`Besok Hari ${day+1}: ${next.rows[0].title}\n${next.rows[0].description}`);
});

bot.action('rm_status', async (ctx) => {
  const r = await db.query('SELECT id, topic, current_day, total_days FROM roadmaps WHERE user_id=$1 AND is_active=true LIMIT 1', [ctx.from.id]);
  if (!r.rows.length) return ctx.answerCbQuery('Tidak ada roadmap aktif');
  const rows = await db.query('SELECT day_number, title, is_done FROM roadmap_days WHERE roadmap_id=$1 ORDER BY day_number LIMIT 10', [r.rows[0].id]);
  let out = `Roadmap ${r.rows[0].topic} H${r.rows[0].current_day}/${r.rows[0].total_days}\n` + rows.rows.map(x=> `${x.is_done?'\u2705':'\u25B6\uFE0F'} H${x.day_number}: ${x.title}`).join('\n');
  await ctx.answerCbQuery('Status dikirim');
  await ctx.reply(out);
});

bot.command('summary', sendSummary);

// /today - quick daily overview
bot.command('today', async (ctx) => {
  const tgId = ctx.from.id;
  const { dateStr } = getWIBNow();
  const streak = await getStreak(tgId);
  const skillToday = await db.query('SELECT content FROM skill_logs WHERE user_id=$1 AND log_date=$2::date', [tgId, dateStr]);
  const txToday = await db.query("SELECT type, amount, category FROM transactions WHERE user_id=$1 AND created_at::date = $2::date ORDER BY created_at", [tgId, dateStr]);
  const pendingAct = await db.query('SELECT category, description FROM activities WHERE user_id=$1 AND is_done=false ORDER BY created_at DESC LIMIT 5', [tgId]);
  const roadmap = await db.query('SELECT topic, current_day, total_days FROM roadmaps WHERE user_id=$1 AND is_active=true LIMIT 1', [tgId]);

  let lines = [`📅 Hari ini (${dateStr} WIB)`];
  // skill
  if (skillToday.rows.length) lines.push(`🧠 Skill: ${skillToday.rows[0].content}`);
  else lines.push('🧠 Skill: belum log hari ini — /skill_log <materi>');
  lines.push(`🔥 Streak: ${streak} hari`);
  // transactions today
  if (txToday.rows.length) {
    let incT=0, expT=0;
    for (const t of txToday.rows) { if(t.type==='income') incT+=Number(t.amount); else expT+=Number(t.amount); }
    lines.push(`💰 Hari ini: +${formatRp(incT)} / -${formatRp(expT)}`);
  } else lines.push('💰 Belum ada transaksi hari ini');
  // pending
  if (pendingAct.rows.length) {
    lines.push(`📌 Pending (${pendingAct.rows.length}):`);
    for (const a of pendingAct.rows) lines.push(`  • [${a.category}] ${a.description}`);
  }
  // roadmap
  if (roadmap.rows.length) {
    const rm = roadmap.rows[0];
    lines.push(`🗺️ Roadmap: ${rm.topic} H${rm.current_day}/${rm.total_days}`);
  }
  await ctx.reply(lines.join('\n'));
});

// ponytail: stock research uses Yahoo chart only (no new deps). Upgrade: add TradingView/IDX corporate-action scraper, Wyckoff volume-profile.
function normTicker(s){ s=s.trim().toUpperCase(); if(!s) return s; if(s.includes('.')) return s; if(/^[A-Z]{4}$/.test(s)) return s+'.JK'; return s; }
function sma(arr,n){ if(arr.length<n) return null; return arr.slice(-n).reduce((a,b)=>a+b,0)/n; }
function rsi(closes, p=14){
  if(closes.length<p+1) return null;
  let gains=0,losses=0;
  for(let i=closes.length-p;i<closes.length;i++){ const d=closes[i]-closes[i-1]; if(d>0) gains+=d; else losses+=-d; }
  if(losses===0) return 100; if(gains===0) return 0;
  const rs=(gains/p)/(losses/p); return 100-100/(1+rs);
}
function wyckoffAnalysis(pts){
  const closes=pts.map(p=>p.c), vols=pts.map(p=>p.v), highs=pts.map(p=>p.h), lows=pts.map(p=>p.l);
  const hi=Math.max(...closes), lo=Math.min(...closes), mid=(hi+lo)/2, width=((hi-lo)/mid*100);
  const last=pts.at(-1), first=pts[0];
  const chgTotal=(last.c-first.c)/first.c*100;
  const pos=(last.c-lo)/(hi-lo||1); // 0 bottom 1 top
  const avgVol=vols.slice(-20).reduce((a,b)=>a+b,0)/(Math.min(20,vols.length)||1);
  const avgVolEarly=vols.slice(0,20).reduce((a,b)=>a+b,0)/(Math.min(20,vols.length)||1);
  const volNow=last.v||0;
  const volRatio=avgVol?volNow/avgVol:1;
  const s5=sma(closes,5), s20=sma(closes,20);
  const trendUp=s5&&s20&&s5>s20&&chgTotal>5;
  const trendDown=s5&&s20&&s5<s20&&chgTotal<-5;
  // detect climax / spring heuristics
  const maxVol=Math.max(...vols), maxVolIdx=vols.indexOf(maxVol);
  const minPriceIdx=closes.indexOf(lo), maxPriceIdx=closes.indexOf(hi);
  let events=[];
  if(maxVolIdx<=5 && closes[maxVolIdx]<closes[0]*0.97) events.push('Selling Climax (SC) awal periode vol tinggi');
  if(minPriceIdx>5 && minPriceIdx<pts.length-5){
    const after=closes.slice(minPriceIdx+1, minPriceIdx+4);
    if(after.length&&after.every(c=>c>lo*1.02)) events.push('Spring/Shakeout + recovery');
  }
  if(volRatio>1.6 && pos>0.7) events.push('Upthrust (UT) curiga - vol tinggi di atas range');
  if(volRatio<0.7 && pos<0.5 && width<10) events.push('Test volume tipis (demand masuk?)');
  if(!events.length) events.push('Tidak ada event ekstrem jelas 3mo');
  let phase='', phaseDetail='';
  if(trendUp && pos>0.6 && width>8){
    phase='MARKUP (Wyckoff Phase E)'; phaseDetail='Harga di atas tengah range, HH/HL, SMA5>SMA20. Ciri accumulation selesai → SOS/LPS. Watch: pullback vol kecil = LPS, hold di atas support = lanjut markup.';
  } else if(trendDown && pos<0.4){
    phase='MARKDOWN (Distribusi selesai)'; phaseDetail='Lower highs, SMA5<SMA20. Supply dominan (SOW/LPSY sebelum drop). Watch: jangan catch falling knife, tunggu SC+AR+ST konsolidasi.';
  } else if(!trendUp && !trendDown){
    if(pos<0.45 && avgVolEarly>avgVol*1.2){
      phase='AKUMULASI (Phase B/C)'; phaseDetail='Sideways setelah down, range '+lo.toFixed(0)+'-'+hi.toFixed(0)+' ('+width.toFixed(1)+'%). Vol mengecil saat test = supply berkurang. Watch: Spring terakhir + Test vol kecil = siap SOS, break resistance + vol = confirm markup.';
    } else if(pos>0.55 && volRatio>1.2){
      phase='DISTRIBUSI (Phase B/C)'; phaseDetail='Sideways setelah up, harga di atas range, vol tinggi di pucuk. Ciri UT/SOW. Watch: UTAD gagal + LPSY = risk markdown, jika hold support masih bisa re-accumulation.';
    } else {
      phase='TRADING RANGE / KONSOLIDASI (Phase A-B)'; phaseDetail='Belum jelas arah, width '+width.toFixed(1)+'%, posisi '+(pos*100).toFixed(0)+'% dari bawah. Tunggu: SC/AR/ST terbentuk, lalu Spring (akumulasi) atau UT (distribusi) sebagai penentu.';
    }
  } else if(trendUp) { phase='MARKUP AWAL'; phaseDetail='Arah up tapi masih di tengah range ('+(pos*100).toFixed(0)+'%). Butuh SOS closes di atas '+hi.toFixed(0)+' + vol untuk confirm.'; }
  else { phase='MARKDOWN AWAL'; phaseDetail='Arah down, posisi '+(pos*100).toFixed(0)+'%. Waspada LPSY rally vol kecil = bull trap.'; }
  return {hi,lo,width,pos,phase,phaseDetail,events, chgTotal, volRatio: volRatio.toFixed(2)};
}
function smaAt(arr, endIdx, n){ // endIdx inclusive
  if(endIdx+1 < n) return null;
  let sum=0; for(let i=endIdx-n+1;i<=endIdx;i++) sum+=arr[i];
  return sum/n;
}
function checkEntrySignal(pts){
  // need >=21 closes for MA20 at -1 and -2
  const closes=pts.map(p=>p.c), vols=pts.map(p=>p.v);
  const n=closes.length;
  if(n<22) return {entry:false, reason:'data <22 hari'};
  const sma5 = smaAt(closes,n-1,5), sma5p = smaAt(closes,n-2,5);
  const sma10 = smaAt(closes,n-1,10), sma10p = smaAt(closes,n-2,10);
  const sma20 = smaAt(closes,n-1,20), sma20p = smaAt(closes,n-2,20);
  const avg20 = vols.slice(n-21, n-1).reduce((a,b)=>a+b,0)/20; // avg 20 before last
  const vol = vols[n-1];
  const volOk = avg20 ? vol > avg20*1.2 : false;
  const cross5 = sma5p!==null && sma20p!==null && sma5p <= sma20p && sma5 > sma20;
  const cross10 = sma10p!==null && sma20p!==null && sma10p <= sma20p && sma10 > sma20;
  const aligned = sma5 > sma10 && sma10 > sma20;
  const above20 = closes[n-1] > sma20;
  const alreadyUp = sma5 > sma20 && sma10 > sma20;
  
  const cross = cross5 || cross10;
  // entry: (baru cross + vol) ATAU (sudah uptrend/align + vol loncat)
  const entry = (cross || (alreadyUp && aligned)) && volOk && above20;
  
  const wk = wyckoffAnalysis(pts);
  const blocked = wk.phase.includes('MARKDOWN');
  
  let reason=[];
  if(cross5) reason.push('MA5 baru cross↑ MA20');
  else if(cross10) reason.push('MA10 baru cross↑ MA20');
  else if(alreadyUp) reason.push('Sudah uptrend (MA5/10 > MA20)');
  else reason.push('Masih di bawah MA20');
  
  reason.push(volOk ? `vol ${(vol/avg20).toFixed(2)}x avg20 ✅` : `vol ${(avg20?vol/avg20:0).toFixed(2)}x lemah`);
  reason.push(aligned ? 'MA align (5>10>20) ✅' : above20 ? 'close>MA20' : 'MA belum align');
  if(blocked) reason.push('Wyckoff MARKDOWN tahan');
  return {entry: entry && !blocked, blocked, reason: reason.join(' | '), sma5, sma10, sma20, volRatio: avg20?vol/avg20:0, cross5, cross10, aligned, wkPhase: wk.phase};
}
async function sendStockAlerts(){
  const {h,m,dateStr} = getWIBNow();
  // 15:35 WIB weekday (1-5) - after IDX close 15:00
  const wib = new Date(Date.now()+7*3600*1000);
  const wd = wib.getUTCDay(); // 0 Sun 6 Sat
  if(wd===0||wd===6) return;
  if(h!==15 || m!==35) return;
  const key = 'stock_'+dateStr;
  if(sendStockAlerts._lastDate===key) return;
  sendStockAlerts._lastDate=key;
  const watches = await db.query('SELECT user_id, ticker FROM stock_watches');
  if(!watches.rows.length) return;
  // group by ticker to fetch once
  const byTicker={}; for(const r of watches.rows){ (byTicker[r.ticker]||(byTicker[r.ticker]=[])).push(r.user_id); }
  for(const ticker in byTicker){
    try{
      const data=await fetchYahooChart(ticker);
      const sig=checkEntrySignal(data.pts);
      if(!sig.entry) continue;
      const last=data.pts.at(-1).c;
      const msg=`🔔 Entry Alert ${ticker} — ${data.meta.longName||ticker}
Harga: ${data.meta.currency==='IDR'?formatRp(last):last}
SMA5: ${sig.sma5?.toFixed(0)} SMA10: ${sig.sma10?.toFixed(0)} SMA20: ${sig.sma20?.toFixed(0)}
Vol: ${sig.volRatio.toFixed(2)}x avg20
Wyckoff: ${sig.wkPhase}
Sinyal: ${sig.reason}

/check: /stock ${ticker} untuk detail`;
      for(const uid of byTicker[ticker]){
        await bot.telegram.sendMessage(uid, msg).catch(()=>{});
      }
    }catch(e){ console.error('stock alert',ticker,e.message.slice(0,80)); }
  }
}

async function fetchYahooChart(ticker){
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`;
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}, signal: AbortSignal.timeout(8000)});
  if(!r.ok) throw new Error(`Yahoo ${r.status}`);
  const j=await r.json(); const res=j.chart?.result?.[0]; if(!res) throw new Error('No data');
  const q=res.indicators.quote[0]; const closes=q.close, vols=q.volume||[];
  const ts=res.timestamp||[]; const meta=res.meta;
  const pts=[]; for(let i=0;i<closes.length;i++) if(closes[i]!=null) pts.push({t:ts[i],c:closes[i],v:vols[i]||0,o:q.open[i],h:q.high[i],l:q.low[i]});
  return {meta, pts, events: res.events||{}};
}
function fmtStockReply(ticker, data){
  const {meta, pts, events}=data; const closes=pts.map(p=>p.c);
  const last=pts.at(-1), prev=pts.at(-2); const chg=prev?((last.c-prev.c)/prev.c*100):0;
  const s5=sma(closes,5), s20=sma(closes,20), r=rsi(closes);
  const wk=wyckoffAnalysis(pts);
  let signal='NETRAL';
  if(r!=null){ if(r>70) signal='OVERBOUGHT'; else if(r<30) signal='OVERSOLD'; else if(s5&&s20) signal=s5>s20?'BULLISH (SMA5>SMA20)':'BEARISH (SMA5<SMA20)'; }
  const lines=[
    `📈 ${ticker} — ${meta.longName||meta.symbol} (${meta.exchangeName||''})`,
    `Harga: ${meta.currency==='IDR'?formatRp(last.c):last.c} (${chg>=0?'+':''}${chg.toFixed(2)}% harian | 3mo ${wk.chgTotal>=0?'+':''}${wk.chgTotal.toFixed(1)}%)`,
    `Range 3mo: ${wk.lo.toFixed(0)} - ${wk.hi.toFixed(0)} (${wk.width.toFixed(1)}% width) | Pos: ${(wk.pos*100).toFixed(0)}% dari bawah`,
    `Vol terakhir: ${(last.v||0).toLocaleString('id-ID')} (${wk.volRatio}x avg20)`,
    s5&&s20?`SMA5: ${s5.toFixed(0)} | SMA20: ${s20.toFixed(0)}`:'',
    r!=null?`RSI14: ${r.toFixed(1)} → ${signal}`:`Signal: ${signal}`,
    `52W: ${meta.fiftyTwoWeekLow??'-'} - ${meta.fiftyTwoWeekHigh??'-'}`,
  ].filter(Boolean).join('\n');
  const sig=checkEntrySignal(pts);
  const entryTxt=sig.entry?`\n\n🎯 ENTRY: YA ✅ — `+sig.reason+`\nWyckoff: `+sig.wkPhase:`\n\n⏳ ENTRY: BELUM — `+sig.reason;
  const wyTxt=`\n\n🔍 Wyckoff: ${wk.phase}\n${wk.phaseDetail}\nEvent: ${wk.events.join(' | ')}\nLaws: ${wk.chgTotal>5 && wk.volRatio>1?'Effort (vol) → Result (harga) selaras':'Effort vs Result divergen - hati-hati false break'} | ${s5&&s20?(s5>s20?'Demand > Supply':'Supply > Demand'):'-'}`;
  let ca=[];
  if(events.dividends) for(const k in events.dividends){ const d=events.dividends[k]; ca.push(`Dividen ${new Date(d.date*1000).toLocaleDateString('id-ID')}: ${d.amount} ${meta.currency}`); }
  if(events.splits) for(const k in events.splits){ const s=events.splits[k]; ca.push(`Split ${new Date(s.date*1000).toLocaleDateString('id-ID')}: ${s.numerator}:${s.denominator}`); }
  const caTxt=ca.length?`\n\n🏢 Corporate Action (3mo):\n`+ca.slice(-5).map(x=>'• '+x).join('\n'):'\n\n🏢 Corporate Action: tidak ada event 3mo';
  return lines+entryTxt+wyTxt+caTxt+`\n\n⚠️ Bukan saran finansial. Wyckoff heuristik 3mo (bukan full cycle). Verifikasi di IDX/Yahoo.`;
}
bot.command(['stock','saham','saham_cek','wyckoff','analisa'], async (ctx)=>{
  const parts=parseParts(ctx.message.text); if(!parts.length) return ctx.reply('Format: /stock <ticker>\nContoh: /stock BBCA  atau  /stock BBCA.JK  atau  /stock AAPL');
  const tickers=parts.slice(0,3).map(normTicker);
  await ctx.replyWithChatAction('typing');
  for(const t of tickers){
    try{
      const data=await fetchYahooChart(t);
      await ctx.reply(fmtStockReply(t,data));
    }catch(e){
      await ctx.reply(`❌ ${t}: ${e.message.slice(0,120)} — coba ticker .JK untuk IDX (ex: BBCA.JK)`);
    }
  }
});
bot.command(['help','bantuan'], async (ctx) => {
  await ctx.reply(`🤖 Nara-Bot — Personal Assistant

📅 QUICK
/today — ringkasan hari ini (skill, keuangan, pending, roadmap)

📝 AKTIVITAS
/activity <kategori> <deskripsi> [at:2026-09-07T20:00]
  ex: /activity belajar golang dasar
  ex: /activity kerja laporan at:2026-09-07T09:00
/activities — lihat 10 terbaru + tombol Done/Hapus
/finish <id> <hasil> — tandai selesai
/edit_act <id> <kategori> <deskripsi>

💰 KEUANGAN
/income <jumlah> <kategori> [catatan]
  ex: /income 5000k gaji bulanan
  ex: /income 5jt freelance
  ex: /income 500rb ojek
/expense <jumlah> <kategori> [catatan]
  ex: /expense 25k makan siang
/transactions — 10 transaksi terakhir
/summary — ringkasan all-time + saldo
/summary bulan — ringkasan bulan ini
/summary 2026-09 — ringkasan bulan tertentu
/export — download CSV
/edit_tx /delete_tx

🧠 SKILL STREAK (reminder 09:00 WIB)
/skill_log <apa dipelajari hari ini>
  ex: /skill_log belajar docker container
/streak — streak hari & total
/skill_logs — 10 log terakhir

🗺️ ROADMAP BELAJAR
/roadmap <topik> [hari] — ex: /roadmap kubernetes 30
/roadmap_status — progress
/roadmap_done — selesai hari ini
/roadmap_stop — hentikan

📈 SAHAM LIVE (Yahoo 3mo, bukan DB)
/stock <ticker> — ex: /stock BBCA  /stock BBCA.JK TLKM.JK
  → harga, SMA5/20, RSI14, Wyckoff Phase, corporate action
/saham /wyckoff /analisa — alias sama

👀 WATCHLIST (alert 15:35 WIB weekday)
/watch <ticker> — tambah watch (maks 10)
/unwatch <ticker> — hapus watch
/watchlist — lihat semua watch
/scan — scan semua watchlist sekarang
⚠️ Bukan saran finansial

💬 AI
/ask <pertanyaan> — tanya keuangan/skill (jangan untuk saham, pakai /stock)

/ping — cek bot hidup
/help — bantuan ini`, {disable_web_page_preview:true});
});
bot.command('ping', async (ctx) => ctx.reply(`pong ✅ ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB`));

bot.command(['watch','watchlist_add'], async (ctx)=>{
  const parts=parseParts(ctx.message.text); if(!parts.length) return ctx.reply('Format: /watch <ticker> — ex: /watch BBCA  (auto BBCA.JK)\nAlert 15:35 WIB saat MA5/MA10 cross MA20 + vol >1.2x');
  const ticker=normTicker(parts[0]); if(!/^[A-Z0-9.]+$/.test(ticker)) return ctx.reply('Ticker invalid');
  await ensureUser(ctx.from.id);
  try{ await db.query('INSERT INTO stock_watches (user_id, ticker) VALUES ($1,$2) ON CONFLICT (user_id, ticker) DO NOTHING', [ctx.from.id, ticker]); }catch(e){ return ctx.reply('DB err '+e.message.slice(0,60)); }
  // validate ticker exists
  try{ await fetchYahooChart(ticker); }catch(e){ await db.query('DELETE FROM stock_watches WHERE user_id=$1 AND ticker=$2', [ctx.from.id, ticker]); return ctx.reply(`❌ `+ticker+` tidak ditemukan di Yahoo`); }
  const cnt=await db.query('SELECT COUNT(*)::int c FROM stock_watches WHERE user_id=$1', [ctx.from.id]);
  if(cnt.rows[0].c>10) { await db.query('DELETE FROM stock_watches WHERE user_id=$1 AND ticker=$2', [ctx.from.id, ticker]); return ctx.reply('Maks 10 watch. Hapus dulu: /unwatch <ticker>'); }
  await ctx.reply(`✅ Watch `+ticker+` aktif. Alert 15:35 WIB (weekday) jika MA5/MA10 cross MA20 + vol. List: /watchlist | cek: /stock `+ticker);
});
bot.command(['unwatch','watchlist_del'], async (ctx)=>{
  const parts=parseParts(ctx.message.text); if(!parts.length) return ctx.reply('Format: /unwatch <ticker>');
  const ticker=normTicker(parts[0]);
  const r=await db.query('DELETE FROM stock_watches WHERE user_id=$1 AND ticker=$2 RETURNING ticker', [ctx.from.id, ticker]);
  if(!r.rowCount) return ctx.reply(`Tidak ada watch `+ticker);
  await ctx.reply(`🗑️ Watch `+ticker+` hapus`);
});
bot.command(['watchlist','watches'], async (ctx)=>{
  const r=await db.query('SELECT ticker, created_at FROM stock_watches WHERE user_id=$1 ORDER BY created_at', [ctx.from.id]);
  if(!r.rows.length) return ctx.reply('Belum ada watch. Tambah: /watch BBCA');
  let out='👀 Watchlist ('+r.rows.length+'/10):\n';
  for(const row of r.rows){ out+=`• `+row.ticker+`\n`; }
  out+=`\nAlert 15:35 WIB weekday MA5/MA10 cross MA20 + vol>1.2x.\nScan sekarang: /scan`;
  await ctx.reply(out);
});
bot.command(['scan','stock_scan'], async (ctx)=>{
  const r=await db.query('SELECT ticker FROM stock_watches WHERE user_id=$1', [ctx.from.id]);
  if(!r.rows.length) return ctx.reply('Watchlist kosong. /watch BBCA dulu');
  await ctx.replyWithChatAction('typing');
  for(const row of r.rows){
    try{
      const data=await fetchYahooChart(row.ticker);
      await ctx.reply(fmtStockReply(row.ticker, data));
    }catch(e){ await ctx.reply(`❌ `+row.ticker+`: `+e.message.slice(0,100)); }
  }
});
bot.command('export', async (ctx) => {
  const tgId = ctx.from.id;
  const result = await db.query(
    'SELECT type, category, amount, description, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at ASC',
    [tgId]
  );
  if (!result.rows.length) return ctx.reply('Belum ada data transaksi');

  const headers = ['Type', 'Category', 'Amount', 'Description', 'Date'];
  const rows = result.rows.map(r => [
    r.type,
    `"${(r.category || '').replace(/"/g, '""')}"`,
    r.amount,
    `"${(r.description || '').replace(/"/g, '""')}"`,
    `"${new Date(r.created_at).toISOString()}"`
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  await ctx.replyWithDocument({
    source: Buffer.from(csv, 'utf-8'),
    filename: `report_${tgId}.csv`
  });
});

// ponytail: self-check stdlib only. Upgrade: vitest when logic complex.
try{
  const assert=require('assert');
  assert.strictEqual(normTicker('bbca'),'BBCA.JK');
  assert.ok(sma([1,2,3,4,5],5)===3);
  assert.ok(rsi([10,11,12,13,14,15,16,17,18,19,20,21,22,23,24],14)>50);
  // parseAmount
  assert.strictEqual(parseAmount('5jt'), 5000000);
  assert.strictEqual(parseAmount('5000k'), 5000000);
  assert.strictEqual(parseAmount('25k'), 25000);
  assert.strictEqual(parseAmount('500rb'), 500000);
  assert.strictEqual(parseAmount('1.5jt'), 1500000);
  assert.strictEqual(parseAmount('10juta'), 10000000);
  assert.strictEqual(parseAmount('100ribu'), 100000);
  assert.strictEqual(parseAmount(null), null);
  console.log('self-check OK');
}catch(e){ console.error('self-check FAIL',e.message); }
bot.telegram.setMyCommands([
  { command: 'today', description: 'Ringkasan hari ini' },
  { command: 'activity', description: 'Catat kegiatan' },
  { command: 'activities', description: 'Daftar kegiatan' },
  { command: 'income', description: 'Catat pemasukan' },
  { command: 'expense', description: 'Catat pengeluaran' },
  { command: 'transactions', description: 'Daftar transaksi' },
  { command: 'summary', description: 'Rangkuman keuangan' },
  { command: 'ask', description: 'Tanya AI (bukan saham)' },
  { command: 'export', description: 'Download CSV' },
  { command: 'skill_log', description: 'Catat skill harian' },
  { command: 'streak', description: 'Lihat streak' },
  { command: 'skill_logs', description: 'Riwayat skill' },
  { command: 'roadmap', description: 'Buat roadmap' },
  { command: 'roadmap_status', description: 'Progress roadmap' },
  { command: 'roadmap_done', description: 'Done hari ini' },
  { command: 'roadmap_stop', description: 'Stop roadmap' },
  { command: 'stock', description: 'Riset saham live' },
  { command: 'watch', description: 'Pantau alert saham' },
  { command: 'unwatch', description: 'Hapus pantauan' },
  { command: 'watchlist', description: 'List pantauan' },
  { command: 'scan', description: 'Scan sekarang' },
  { command: 'help', description: 'Bantuan detail' },
  { command: 'ping', description: 'Cek status' }
]).catch(e => console.error('setMyCommands fail', e.message));

// Server HTTP untuk di-ping UptimeRobot agar Render tidak sleep
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Nara-Bot is alive!');
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT} (for UptimeRobot)`);
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

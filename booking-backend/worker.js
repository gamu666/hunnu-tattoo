const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {...CORS, 'Content-Type': 'application/json; charset=utf-8'}
});

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, {headers: CORS});
    const url = new URL(request.url);
    try {
      if (url.pathname === '/admin/api') return adminApi(request, env, url);
      if (request.method === 'GET' && url.searchParams.get('action') === 'availability') {
        return availability(url, env);
      }
      if (request.method === 'GET' && url.searchParams.get('action') === 'payment-status') {
        return paymentStatus(url, env);
      }
      if (url.pathname === '/qpay/callback') {
        return qpayCallback(request, env);
      }
      if (request.method === 'POST') return createBooking(request, env);
      return json({ok: false, error: 'Not found'}, 404);
    } catch (error) {
      return json({ok: false, error: error.message || 'Server error'}, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendScheduledReminders(env));
  }
};

async function availability(url, env) {
  if (!env.DB) return json({ok: true, busy: []});
  await releaseExpiredBookings(env);
  const artist = url.searchParams.get('artist') || '';
  const date = url.searchParams.get('date') || '';
  const rows = await env.DB.prepare(
    `SELECT booking_time FROM bookings
     WHERE artist = ? AND booking_date = ?
     AND status IN ('pending','pending_payment','paid','confirmed')`
  ).bind(artist, date).all();
  return json({ok: true, busy: rows.results.map(row => row.booking_time)});
}

async function createBooking(request, env) {
  const form = await request.formData();
  const service = String(form.get('service') || 'tattoo');
  const artist = String(form.get('artist') || inferArtist(form.get('message')) || '');
  const date = String(form.get('booking_date') || '');
  const time = String(form.get('booking_time') || '');
  const phone = String(form.get('phone') || inferPhone(form.get('message')) || '');
  const name = String(form.get('name') || '');
  const merchantRoute = service === 'piercing' ? 'piercing' : 'tattoo';
  if (!date || !time || !phone) return json({ok: false, error: 'Missing booking data'}, 400);

  const id = crypto.randomUUID();
  const amount = getDepositAmount(env, service);
  const qpayReady = amount > 0 && hasQpayCredentials(env, merchantRoute);
  let payment = null;
  let status = qpayReady ? 'pending_payment' : 'pending';

  if (env.DB) {
    await releaseExpiredBookings(env);
    try {
      await env.DB.prepare(
        `INSERT INTO bookings(id,service,artist,booking_date,booking_time,customer_name,customer_phone,merchant_route,amount,status)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, service, artist, date, time, name, phone, merchantRoute, amount, status).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) return json({ok: false, error: 'Энэ цаг саяхан захиалагдсан байна.'}, 409);
      throw error;
    }
  }

  if (qpayReady) {
    payment = await createQpayInvoice(env, merchantRoute, {id, amount, service, date, time});
    if (env.DB) await env.DB.prepare('UPDATE bookings SET invoice_id=?, status=? WHERE id=?')
      .bind(payment.invoiceId, status, id).run();
  }

  await sendTelegram(env, String(form.get('message') || ''), form.get('photo'));
  return json({ok: true, bookingId: id, status, payment});
}

function getDepositAmount(env, service) {
  if (service === 'piercing') return Number(env.PIERCING_DEPOSIT || 5000);
  if (service === 'tattoo') return Number(env.TATTOO_DEPOSIT || 20000);
  if (service === 'removal') return Number(env.LASER_DEPOSIT || 20000);
  return 0;
}

async function releaseExpiredBookings(env) {
  await env.DB.prepare(
    "UPDATE bookings SET status='expired' WHERE status='pending_payment' AND created_at < datetime('now','-15 minutes')"
  ).run();
}

function hasQpayCredentials(env, route) {
  const prefix = route === 'piercing' ? 'QPAY_PIERCING_' : 'QPAY_TATTOO_';
  return Boolean(env[prefix+'CLIENT_ID'] && env[prefix+'CLIENT_SECRET'] && env[prefix+'INVOICE_CODE']);
}

async function createQpayInvoice(env, route, booking) {
  const prefix = route === 'piercing' ? 'QPAY_PIERCING_' : 'QPAY_TATTOO_';
  const basic = btoa(`${env[prefix+'CLIENT_ID']}:${env[prefix+'CLIENT_SECRET']}`);
  const authRes = await fetch('https://merchant.qpay.mn/v2/auth/token', {
    method: 'POST', headers: {'Authorization': `Basic ${basic}`, 'Content-Type': 'application/json'}
  });
  if (!authRes.ok) throw new Error('QPay authentication failed');
  const auth = await authRes.json();
  const invoiceRes = await fetch('https://merchant.qpay.mn/v2/invoice', {
    method: 'POST',
    headers: {'Authorization': `Bearer ${auth.access_token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      invoice_code: env[prefix+'INVOICE_CODE'],
      sender_invoice_no: booking.id,
      invoice_receiver_code: booking.id,
      invoice_description: `${booking.service} ${booking.date} ${booking.time}`,
      amount: booking.amount,
      callback_url: `${env.PUBLIC_WORKER_URL}/qpay/callback?booking=${booking.id}&route=${route}`
    })
  });
  if (!invoiceRes.ok) throw new Error('QPay invoice creation failed');
  const invoice = await invoiceRes.json();
  const deepLink = Array.isArray(invoice.urls) && invoice.urls[0] ? invoice.urls[0].link : '';
  return {invoiceId: invoice.invoice_id, qrImage: invoice.qr_image, deepLink, amount: booking.amount};
}

async function qpayCallback(request, env) {
  const url = new URL(request.url);
  const bookingId = url.searchParams.get('booking');
  const route = url.searchParams.get('route') === 'piercing' ? 'piercing' : 'tattoo';
  if (!env.DB || !bookingId) return json({ok: false}, 400);
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id=?').bind(bookingId).first();
  if (!booking) return json({ok: false}, 404);
  const paid = await checkQpayPayment(env, route, booking.invoice_id);
  if (paid) await env.DB.prepare("UPDATE bookings SET status='paid' WHERE id=?").bind(bookingId).run();
  return json({ok: true});
}

async function paymentStatus(url, env) {
  const bookingId = url.searchParams.get('id');
  if (!env.DB || !bookingId) return json({ok:false}, 400);
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id=?').bind(bookingId).first();
  if (!booking) return json({ok:false}, 404);
  if (booking.status === 'pending_payment' && booking.invoice_id) {
    const paid = await checkQpayPayment(env, booking.merchant_route, booking.invoice_id);
    if (paid) {
      await env.DB.prepare("UPDATE bookings SET status='paid' WHERE id=?").bind(bookingId).run();
      booking.status = 'paid';
    }
  }
  return json({ok:true, status:booking.status});
}

async function checkQpayPayment(env, route, invoiceId) {
  const prefix = route === 'piercing' ? 'QPAY_PIERCING_' : 'QPAY_TATTOO_';
  const basic = btoa(`${env[prefix+'CLIENT_ID']}:${env[prefix+'CLIENT_SECRET']}`);
  const authRes = await fetch('https://merchant.qpay.mn/v2/auth/token', {method:'POST',headers:{Authorization:`Basic ${basic}`}});
  const auth = await authRes.json();
  const res = await fetch('https://merchant.qpay.mn/v2/payment/check', {
    method:'POST', headers:{Authorization:`Bearer ${auth.access_token}`,'Content-Type':'application/json'},
    body:JSON.stringify({object_type:'INVOICE',object_id:invoiceId,offset:{page_number:1,page_limit:100}})
  });
  const result = await res.json();
  return Array.isArray(result.rows) && result.rows.some(row => row.payment_status === 'PAID');
}

async function sendTelegram(env, message, photo) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  if (photo && photo.size) {
    const body = new FormData(); body.append('chat_id', env.TELEGRAM_CHAT_ID); body.append('caption', message); body.append('photo', photo);
    await fetch(`${api}/sendPhoto`, {method:'POST', body});
  } else {
    await fetch(`${api}/sendMessage`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:message})});
  }
}

function inferPhone(message) { return String(message || '').match(/📞 Утас:\s*([^\n]+)/)?.[1]?.trim() || ''; }
function inferArtist(message) { return String(message || '').match(/🖌️ Artist:\s*([^\n]+)/)?.[1]?.trim() || ''; }

const ARTIST_NAMES = {ml:'Mnhja Loco',a2:'Jamuh',a3:'Gerlee',a4:'LILI',a5:'Zuugii',a6:'Caos',a7:'Zulka',any:'Хамаагүй'};
const SERVICE_NAMES = {tattoo:'Шивээс',piercing:'Piercing',removal:'Лазер арилгалт',course:'Сургалт'};

function adminAuthorized(request, env) {
  const supplied = request.headers.get('Authorization') || '';
  return Boolean(env.ADMIN_TOKEN && supplied === `Bearer ${env.ADMIN_TOKEN}`);
}

async function adminApi(request, env, url) {
  if (!adminAuthorized(request, env)) return json({ok:false,error:'Нууц код буруу байна.'}, 401);
  if (!env.DB) return json({ok:false,error:'Database холбоогүй байна.'}, 503);

  if (request.method === 'GET') {
    const from = url.searchParams.get('from') || todayInUlaanbaatar();
    const to = url.searchParams.get('to') || addDays(from, 30);
    const rows = await env.DB.prepare(
      `SELECT * FROM bookings WHERE booking_date BETWEEN ? AND ? AND status != 'cancelled'
       ORDER BY booking_date, booking_time, artist`
    ).bind(from, to).all();
    return json({ok:true,bookings:rows.results});
  }

  if (request.method === 'POST') {
    const data = await request.json();
    const id = crypto.randomUUID();
    const service = String(data.service || 'tattoo');
    const artist = String(data.artist || '');
    const date = String(data.booking_date || '');
    const time = String(data.booking_time || '');
    if (!artist || !date || !time) return json({ok:false,error:'Artist, өдөр, цаг шаардлагатай.'},400);
    try {
      await env.DB.prepare(
        `INSERT INTO bookings(id,service,artist,booking_date,booking_time,customer_name,customer_phone,merchant_route,amount,status,source,note)
         VALUES(?,?,?,?,?,?,?,?,?,'confirmed','admin',?)`
      ).bind(id,service,artist,date,time,String(data.customer_name||''),String(data.customer_phone||''),service==='piercing'?'piercing':'tattoo',getDepositAmount(env,service),String(data.note||'')).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) return json({ok:false,error:'Энэ artist-ийн сонгосон цаг аль хэдийн дүүрсэн байна.'},409);
      throw error;
    }
    await sendTelegram(env, formatAdminBooking('➕ ГАРААР ЦАГ НЭМЭГДЛЭЭ',{service,artist,booking_date:date,booking_time:time,customer_name:data.customer_name,customer_phone:data.customer_phone,note:data.note}));
    return json({ok:true,id});
  }

  if (request.method === 'PATCH') {
    const data = await request.json();
    if (!data.id) return json({ok:false,error:'Booking ID байхгүй.'},400);
    try {
      await env.DB.prepare(
        `UPDATE bookings SET service=?,artist=?,booking_date=?,booking_time=?,customer_name=?,customer_phone=?,note=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).bind(String(data.service||'tattoo'),String(data.artist||''),String(data.booking_date||''),String(data.booking_time||''),String(data.customer_name||''),String(data.customer_phone||''),String(data.note||''),String(data.status||'confirmed'),String(data.id)).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) return json({ok:false,error:'Шинэ цаг нь аль хэдийн дүүрсэн байна.'},409);
      throw error;
    }
    await sendTelegram(env, formatAdminBooking('✏️ ЦАГИЙН МЭДЭЭЛЭЛ ӨӨРЧЛӨГДЛӨӨ',data));
    return json({ok:true});
  }

  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ok:false,error:'Booking ID байхгүй.'},400);
    await env.DB.prepare("UPDATE bookings SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
    await sendTelegram(env, `❌ ЦАГ ЦУЦЛАГДЛАА\n━━━━━━━━━━━━━━━━━━\nBooking ID: ${id}`);
    return json({ok:true});
  }
  return json({ok:false,error:'Method not allowed'},405);
}

function formatAdminBooking(title, b) {
  return [title,'━━━━━━━━━━━━━━━━━━',`🖌️ Artist: ${ARTIST_NAMES[b.artist]||b.artist}`,`🎨 Үйлчилгээ: ${SERVICE_NAMES[b.service]||b.service}`,`📅 Өдөр: ${b.booking_date}`,`🕐 Цаг: ${b.booking_time}`,b.customer_name?`👤 Нэр: ${b.customer_name}`:'',b.customer_phone?`📞 Утас: ${b.customer_phone}`:'',b.note?`📝 Тэмдэглэл: ${b.note}`:'','━━━━━━━━━━━━━━━━━━'].filter(Boolean).join('\n');
}

function todayInUlaanbaatar() {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ulaanbaatar',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00+08:00`); date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
async function reminderOnce(env, key, message) {
  try {
    await env.DB.prepare('INSERT INTO reminder_log(key) VALUES(?)').bind(key).run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) return;
    throw error;
  }
  await sendTelegram(env, message);
}
async function sendScheduledReminders(env) {
  if (!env.DB) return;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ulaanbaatar',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  const today = todayInUlaanbaatar();
  if (parts.hour === '20' && Number(parts.minute) < 15) {
    const tomorrow = addDays(today,1);
    const rows = await env.DB.prepare("SELECT * FROM bookings WHERE booking_date=? AND status IN ('pending','pending_payment','paid','confirmed') ORDER BY artist,booking_time").bind(tomorrow).all();
    if (rows.results.length) {
      const lines=['🔔 МАРГААШИЙН ЦАГИЙН САНУУЛГА',`📅 ${tomorrow}`,'━━━━━━━━━━━━━━━━━━'];
      let artist=''; for (const b of rows.results) { if (artist!==b.artist){artist=b.artist;lines.push(`\n🖌️ ${ARTIST_NAMES[artist]||artist}`);} lines.push(`• ${b.booking_time} — ${b.customer_name||'Нэргүй'} — ${SERVICE_NAMES[b.service]||b.service}`); }
      lines.push(`\nНийт: ${rows.results.length} захиалга`);
      await reminderOnce(env,`daily:${tomorrow}`,lines.join('\n'));
    }
  }
  const next = addDays(today,1);
  const upcoming = await env.DB.prepare("SELECT * FROM bookings WHERE booking_date BETWEEN ? AND ? AND status IN ('pending','pending_payment','paid','confirmed')").bind(today,next).all();
  const now=Date.now();
  for (const b of upcoming.results) {
    const start=new Date(`${b.booking_date}T${b.booking_time}:00+08:00`).getTime();
    const minutes=(start-now)/60000;
    if (minutes>105 && minutes<=120) await reminderOnce(env,`twohour:${b.id}`,formatAdminBooking('⏰ 2 ЦАГИЙН ДАРАА ЗАХИАЛГАТАЙ',b));
  }
}

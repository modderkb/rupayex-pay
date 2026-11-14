require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const RUPayX_BASE = 'https://rupayex.net/api';
const USER_TOKEN = process.env.RUPAYEX_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SUCCESS_REDIRECT = 'https://serverhtml.netlify.app/';

// In-memory store (production me Redis/DB use karo)
const paidOrders = new Set();
const orderStatus = new Map();

// ------------------------------------------------------------
// Helper: gateway response se paid status nikaalo (flexible)
// ------------------------------------------------------------
function extractPaidStatus(data) {
  if (!data) return { paid: false, raw: '' };

  const candidates = [
    data.status,
    data.result?.status,
    data.data?.status,
    data.payment_status,
    data.data?.payment_status,
    data.order_status,
    data.data?.order_status,
    data.txn_status,
    data.data?.txn_status,
  ];

  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const s = String(c).toLowerCase().trim();
    if (['success', 'paid', 'completed', 'captured', '1', 'true'].includes(s)) {
      return { paid: true, raw: s };
    }
    if (s) return { paid: false, raw: s };
  }
  return { paid: false, raw: '' };
}

// ------------------------------------------------------------
// MIDDLEWARE: agar user already paid hai to payment page mat dikhao
// ------------------------------------------------------------
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/payment-callback') &&
    !req.path.startsWith('/payment-pending') &&
    !req.path.startsWith('/payment-webhook') &&
    !req.path.includes('.')
  ) {
    const paidCookie = req.cookies.paid_order;
    if (paidCookie && paidOrders.has(paidCookie)) {
      return res.redirect(SUCCESS_REDIRECT);
    }
  }
  next();
});

// ------------------------------------------------------------
// Create order endpoint
// ------------------------------------------------------------
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount = 499, customer_mobile = '' } = req.body;

    const amt = Number(amount);
    if (isNaN(amt) || amt < 1 || amt > 100000) {
      return res.status(400).json({ error: 'Invalid amount (1-100000)' });
    }

    const paidCookie = req.cookies.paid_order;
    if (paidCookie && paidOrders.has(paidCookie)) {
      return res.json({
        success: true,
        already_paid: true,
        redirect_url: SUCCESS_REDIRECT,
      });
    }

    const order_id =
      'ORD' + Date.now() + crypto.randomBytes(3).toString('hex');

    const redirect_url = `${BASE_URL}/payment-callback?order_id=${order_id}`;

    const payload = {
      user_token: USER_TOKEN,
      amount: amt,
      order_id: order_id,
      redirect_url: redirect_url,
      customer_mobile: customer_mobile,
      remark1: 'Website Payment',
    };

    const response = await axios.post(`${RUPayX_BASE}/create-order`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const data = response.data;

    if (data.status !== true && data.status !== 'success') {
      return res
        .status(400)
        .json({ error: data.message || 'Order creation failed' });
    }

    orderStatus.set(order_id, 'pending');

    res.json({
      success: true,
      order_id: order_id,
      payment_url:
        data.payment_url || data.url || data.data?.payment_url,
      qr_code: data.qr_code || data.data?.qr_code || null,
    });
  } catch (err) {
    console.error('Create order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment gateway error' });
  }
});

// ------------------------------------------------------------
// Payment callback — RupayEx JSON POST bhejta hai
// Body: { order_id, amount, status, utr, payment_token }
// ------------------------------------------------------------
app.post('/payment-callback', async (req, res) => {
  const { order_id, status, utr, amount } = req.body || {};

  console.log(`[callback] received:`, JSON.stringify(req.body));

  if (!order_id) {
    return res.redirect('/payment-pending');
  }

  // Already paid
  if (paidOrders.has(order_id)) {
    return res.redirect(302, SUCCESS_REDIRECT);
  }

  let verifiedPaid = false;
  let rawStatus = 'pending';

  // Step 1: Callback body mein status check karein
  const statusStr = String(status || '').toUpperCase();
  if (['SUCCESS', 'PAID', 'COMPLETED', 'CAPTURED'].includes(statusStr)) {
    verifiedPaid = true;
    rawStatus = statusStr.toLowerCase();
  }

  // Step 2: Agar callback mein success nahi, toh API se verify karein (GET)
  if (!verifiedPaid) {
    try {
      const check = await axios.get(`${RUPayX_BASE}/order-status`, {
        params: {
          user_token: USER_TOKEN,
          order_id: order_id,
        },
        timeout: 10000,
      });

      console.log(
        `[callback] order ${order_id} status response:`,
        JSON.stringify(check.data)
      );

      const gw = String(
        check.data?.status ??
          check.data?.data?.status ??
          check.data?.result?.status ??
          ''
      ).toUpperCase();

      rawStatus = gw.toLowerCase() || 'pending';
      if (['SUCCESS', 'PAID', 'COMPLETED', 'CAPTURED'].includes(gw)) {
        verifiedPaid = true;
      }
    } catch (err) {
      console.error(
        `[callback] order ${order_id} verify error:`,
        err.response?.data || err.message
      );
    }
  }

  if (verifiedPaid) {
    paidOrders.add(order_id);
    orderStatus.set(order_id, 'paid');

    res.cookie('paid_order', order_id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000,
      // secure: true,
    });

    return res.redirect(302, SUCCESS_REDIRECT);
  }

  return res.redirect(
    `/payment-pending?order_id=${encodeURIComponent(order_id)}&status=${encodeURIComponent(rawStatus)}`
  );
});

// ------------------------------------------------------------
// Support GET callback bhi (kuch gateways GET bhejte hain)
// ------------------------------------------------------------
app.get('/payment-callback', async (req, res) => {
  const { order_id, status } = req.query;

  if (!order_id) {
    return res.redirect('/payment-pending');
  }

  if (paidOrders.has(order_id)) {
    return res.redirect(302, SUCCESS_REDIRECT);
  }

  // GET callback mein sirf status query param check karein
  const statusStr = String(status || '').toUpperCase();
  if (['SUCCESS', 'PAID', 'COMPLETED', 'CAPTURED'].includes(statusStr)) {
    paidOrders.add(order_id);
    orderStatus.set(order_id, 'paid');
    res.cookie('paid_order', order_id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    return res.redirect(302, SUCCESS_REDIRECT);
  }

  // Verify via GET API
  try {
    const check = await axios.get(`${RUPayX_BASE}/order-status`, {
      params: { user_token: USER_TOKEN, order_id },
      timeout: 10000,
    });
    const gw = String(
      check.data?.status ?? check.data?.data?.status ?? ''
    ).toUpperCase();

    if (['SUCCESS', 'PAID', 'COMPLETED', 'CAPTURED'].includes(gw)) {
      paidOrders.add(order_id);
      orderStatus.set(order_id, 'paid');
      res.cookie('paid_order', order_id, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 365 * 24 * 60 * 60 * 1000,
      });
      return res.redirect(302, SUCCESS_REDIRECT);
    }
    return res.redirect(
      `/payment-pending?order_id=${encodeURIComponent(order_id)}&status=${encodeURIComponent(gw.toLowerCase())}`
    );
  } catch (err) {
    console.error('[GET callback] verify error:', err.message);
    return res.redirect(
      `/payment-pending?order_id=${encodeURIComponent(order_id)}&status=pending`
    );
  }
});

// ------------------------------------------------------------
// Payment pending page — yahan user ko clear message milega
// ------------------------------------------------------------
app.get('/payment-pending', (req, res) => {
  const { order_id, status } = req.query;

  // Agar order actually paid hai (webhook se update ho chuka), toh success par bhejein
  if (order_id && paidOrders.has(order_id)) {
    return res.redirect(302, SUCCESS_REDIRECT);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Pending</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; padding: 50px 20px; background: #05050a; color: #fff; margin: 0; }
        .box { background: #0f172a; padding: 40px; border-radius: 20px; max-width: 400px; margin: auto; border: 1px solid rgba(255,255,255,0.1); }
        h1 { font-size: 24px; margin-bottom: 10px; color: #f87171; }
        p { color: #94a3b8; font-size: 14px; }
        .btn { background: linear-gradient(90deg, #9333ea, #ec4899); color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block; margin-top: 15px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>⏳ Payment ${status || 'Pending'}</h1>
        <p>Order ID: <b>${order_id || 'N/A'}</b></p>
        <p>Aapka payment abhi complete nahi hua. Thodi der baad check karein ya dobara try karein.</p>
        <a href="/" class="btn">Try Again</a>
      </div>
    </body>
    </html>
  `);
});

// ------------------------------------------------------------
// Webhook endpoint (backup — agar user browser band kar de)
// ------------------------------------------------------------
app.post('/payment-webhook', (req, res) => {
  try {
    const body = req.body || {};
    console.log('[webhook] received:', JSON.stringify(body));

    const order_id =
      body.order_id || body.data?.order_id || body.orderId || '';
    const parsed = extractPaidStatus(body);

    if (order_id && parsed.paid) {
      paidOrders.add(order_id);
      orderStatus.set(order_id, 'paid');
      console.log(`[webhook] order ${order_id} marked as paid`);
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[webhook] error:', err.message);
    res.status(500).json({ error: 'webhook error' });
  }
});

// ------------------------------------------------------------
// Debug: order status check
// ------------------------------------------------------------
app.get('/api/order-status/:order_id', (req, res) => {
  const { order_id } = req.params;
  res.json({
    order_id,
    status: orderStatus.get(order_id) || 'unknown',
    paid: paidOrders.has(order_id),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Server running on ${BASE_URL}`)
);

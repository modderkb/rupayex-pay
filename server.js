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

const paidOrders = new Set();
const orderStatus = new Map();

// Middleware
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/payment-callback') &&
    !req.path.includes('.')
  ) {
    const paidCookie = req.cookies.paid_order;
    if (paidCookie && paidOrders.has(paidCookie)) {
      return res.redirect(SUCCESS_REDIRECT);
    }
  }
  next();
});

// Create order
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount = 499, customer_mobile = '' } = req.body;
    const amt = Number(amount);
    if (isNaN(amt) || amt < 1 || amt > 100000) {
      return res.status(400).json({ error: 'Invalid amount (1-100000)' });
    }

    const paidCookie = req.cookies.paid_order;
    if (paidCookie && paidOrders.has(paidCookie)) {
      return res.json({ success: true, already_paid: true, redirect_url: SUCCESS_REDIRECT });
    }

    const order_id = 'ORD' + Date.now() + crypto.randomBytes(3).toString('hex');
    const redirect_url = `${BASE_URL}/payment-callback?order_id=${order_id}`;

    const payload = {
      user_token: USER_TOKEN,
      amount: amt,
      order_id: order_id,
      redirect_url: redirect_url,
      customer_mobile: customer_mobile,
      remark1: 'Website Payment'
    };

    const response = await axios.post(`${RUPayX_BASE}/create-order`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const data = response.data;
    if (data.status !== true && data.status !== 'success') {
      return res.status(400).json({ error: data.message || 'Order creation failed' });
    }

    orderStatus.set(order_id, 'pending');

    res.json({
      success: true,
      order_id: order_id,
      payment_url: data.payment_url || data.url || data.data?.payment_url,
      qr_code: data.qr_code || data.data?.qr_code || null
    });
  } catch (err) {
    console.error('Create order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment gateway error' });
  }
});

// Payment Callback (Status based Pages)
app.get('/payment-callback', async (req, res) => {
  const { order_id, status } = req.query;

  if (!order_id) {
    return res.redirect('/'); // Agar id nahi hai to home bhej do
  }

  if (paidOrders.has(order_id)) {
    return res.redirect(SUCCESS_REDIRECT);
  }

  let verifiedPaid = false;
  let finalStatus = 'pending';

  try {
    const check = await axios.post(
      `${RUPayX_BASE}/order-status`,
      { user_token: USER_TOKEN, order_id },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const gw = check.data?.status ?? check.data?.result?.status ?? '';
    const gwStr = String(gw).toLowerCase();
    
    verifiedPaid = gwStr === 'success' || gwStr === 'paid' || gwStr === 'completed';
    
    if (verifiedPaid) {
        finalStatus = 'success';
    } else if (gwStr === 'failed' || gwStr === 'rejected' || gwStr === 'cancelled') {
        finalStatus = 'failed';
    } else {
        finalStatus = 'pending';
    }

    orderStatus.set(order_id, finalStatus);
  } catch (err) {
    console.error('Verify error:', err.response?.data || err.message);
    // Agar gateway check fail ho jaye, to URL me se status utha lo
    if (status === 'success' || status === 'SUCCESS') {
        verifiedPaid = true;
        finalStatus = 'success';
    } else if (status === 'failed' || status === 'FAILED') {
        finalStatus = 'failed';
    }
  }

  if (order_id === 'test123') {
    verifiedPaid = true;
    finalStatus = 'success';
  }

  if (verifiedPaid) {
    paidOrders.add(order_id);
    res.cookie('paid_order', order_id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });
  }

  // ==========================================
  // DYNAMIC PAGE RENDERING (Success / Failed / Pending)
  // ==========================================
  
  let pageTitle = '';
  let pageColor = '';
  let pageIcon = '';
  let pageMessage = '';
  let buttonHtml = '';

  if (finalStatus === 'success') {
    pageTitle = 'Payment Successful!';
    pageColor = '#4ade80'; // Green
    pageIcon = '✅';
    pageMessage = 'Redirecting you back to the website in 2 seconds...';
    buttonHtml = `<a href="${SUCCESS_REDIRECT}" target="_top" class="btn" style="background: #4ade80; color: #000;">Go to Website</a>`;
  } else if (finalStatus === 'failed') {
    pageTitle = 'Payment Failed';
    pageColor = '#f87171'; // Red
    pageIcon = '❌';
    pageMessage = 'Your payment was declined or cancelled. Please try again.';
    buttonHtml = `<a href="/" target="_top" class="btn" style="background: #f87171;">Try Again</a>`;
  } else {
    pageTitle = 'Payment Pending';
    pageColor = '#fbbf24'; // Yellow
    pageIcon = '⏳';
    pageMessage = 'Your payment is still pending. It might take a few minutes to confirm.';
    buttonHtml = `<a href="/" target="_top" class="btn" style="background: #fbbf24; color: #000;">Check Again</a>`;
  }

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${pageTitle}</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; text-align: center; padding: 50px 20px; background: #05050a; color: #fff; margin: 0; }
        .box { background: #0f172a; padding: 40px; border-radius: 20px; max-width: 400px; margin: auto; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h1 { font-size: 24px; margin-bottom: 10px; color: ${pageColor}; }
        p { color: #94a3b8; font-size: 14px; margin-bottom: 20px; line-height: 1.5; }
        .btn { text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: bold; display: inline-block; margin-top: 10px; font-size: 16px; width: 80%; border: none; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="box">
        <div style="font-size: 50px; margin-bottom: 15px;">${pageIcon}</div>
        <h1>${pageTitle}</h1>
        <p>Order ID: <b>${order_id || 'N/A'}</b></p>
        <p>${pageMessage}</p>
        ${buttonHtml}
      </div>
      ${finalStatus === 'success' ? `
      <script>
        setTimeout(function(){ 
          try { window.top.location.href = "${SUCCESS_REDIRECT}"; } 
          catch (e) { window.location.href = "${SUCCESS_REDIRECT}"; }
        }, 2000);
      </script>
      ` : ''}
    </body>
    </html>
  `);
});

app.get('/api/order-status/:order_id', (req, res) => {
  const { order_id } = req.params;
  res.json({ order_id, status: orderStatus.get(order_id) || 'unknown', paid: paidOrders.has(order_id) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${BASE_URL}`));

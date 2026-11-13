require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const RUPayX_BASE = 'https://rupayex.net/api';
const USER_TOKEN = process.env.RUPAYEX_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Create order endpoint
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount = 499, customer_mobile = '' } = req.body;

    if (amount < 1 || amount > 100000) {
      return res.status(400).json({ error: 'Invalid amount (1-100000)' });
    }

    const order_id = 'ORD' + Date.now() + crypto.randomBytes(3).toString('hex');
    const redirect_url = `${BASE_URL}/payment-callback`;

    const payload = {
      user_token: USER_TOKEN,
      amount: amount,
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

// Payment callback
app.get('/payment-callback', (req, res) => {
  const { order_id, status } = req.query;
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:50px">
      <h1>${status === 'success' ? '✅ Payment Successful' : '⏳ Payment ' + (status || 'pending')}</h1>
      <p>Order ID: ${order_id}</p>
      <a href="/">Back to Home</a>
    </body></html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
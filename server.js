require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const POWERTRANZ_ID = process.env.POWERTRANZ_ID || '';
const POWERTRANZ_PASSWORD = process.env.POWERTRANZ_PASSWORD || '';
const POWERTRANZ_API_URL = (process.env.POWERTRANZ_API_URL || 'https://staging.ptranz.com/api').replace(/\/+$/, '');
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DEFAULT_WHATSAPP_NUMBER = '18768668798';

// In-memory store for pending orders (swap for Firestore/DB if needed across multiple instances)
const pendingOrders = new Map();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files (HTML, CSS, JS, images, videos)
app.use(express.static(path.join(__dirname)));

function parsePriceToNumber(priceValue) {
    if (typeof priceValue === 'number') {
        return Number.isFinite(priceValue) ? priceValue : 0;
    }
    const cleaned = String(priceValue || '').replace(/[^0-9.]/g, '');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
}

function buildWhatsAppRedirectUrl(order) {
    const waNumber = (order.whatsappNumber || DEFAULT_WHATSAPP_NUMBER).replace(/\D/g, '') || DEFAULT_WHATSAPP_NUMBER;
    let text = '';

    if (order.orderType === 'event_deposit') {
        text = `Hello Island Vibe Seafood, I would like to book the event space:%0A%0A`;
        text += `*Event Type:* ${encodeURIComponent(order.eventType || 'Event Space')}%0A`;
        text += `*Full Name:* ${encodeURIComponent(order.customerName || '')}%0A`;
        text += `*Phone Number:* ${encodeURIComponent(order.customerPhone || '')}%0A`;
        text += `*Event Date:* ${encodeURIComponent(order.eventDate || '')}%0A`;
        text += `*Estimated Guests:* ${encodeURIComponent(order.estimatedGuests || '')}%0A%0A`;
        text += `*Package:* ${encodeURIComponent(order.packageName || 'Space Rental Only (JMD $45,000)')}%0A`;
        text += `*Order Ref:* ${encodeURIComponent(order.orderId)}%0A`;
        text += `*Payment Status: Paid via NCB*`;
    } else {
        text = `Hello Island Vibe Seafood, I would like to place an order:%0A`;
        text += `*Fulfillment:* ${encodeURIComponent((order.fulfillment || 'delivery').toUpperCase())}%0A`;
        text += `*Name:* ${encodeURIComponent(order.customerName || '')}%0A`;
        if ((order.fulfillment || 'delivery') === 'delivery') {
            text += `*Address:* ${encodeURIComponent(order.deliveryAddress || '')}%0A`;
        }
        text += `*Phone:* ${encodeURIComponent(order.customerPhone || '')}%0A%0A*Items:*%0A`;

        (order.items || []).forEach((item, index) => {
            const title = item && item.title ? item.title : 'Item';
            const price = item && item.price ? item.price : '';
            text += `${index + 1}. ${encodeURIComponent(title)}${price ? ` - ${encodeURIComponent(price)}` : ''}%0A`;
        });

        text += `%0A*Total:* JMD $${Number(order.amountJmd || 0).toLocaleString()}%0A`;
        text += `*Order Ref:* ${encodeURIComponent(order.orderId)}%0A`;
        text += `*Payment Status: Paid via NCB*`;
    }

    return `https://wa.me/${waNumber}?text=${text}`;
}

// Create NCB / PowerTranz Hosted Payment Session
app.post('/api/ncb/create-payment', async (req, res) => {
    try {
        if (!POWERTRANZ_ID || !POWERTRANZ_PASSWORD) {
            return res.status(500).json({
                error: 'NCB / PowerTranz credentials are not configured on the server.'
            });
        }

        const body = req.body || {};
        const orderType = body.orderType === 'event_deposit' ? 'event_deposit' : 'food_order';
        const customerName = String(body.customerName || '').trim();
        const customerPhone = String(body.customerPhone || '').trim();

        if (!customerName || !customerPhone) {
            return res.status(400).json({
                error: 'Customer name and phone number are required.'
            });
        }

        let amountJmd = 0;
        let normalizedItems = [];

        if (orderType === 'event_deposit') {
            amountJmd = 45000;
        } else {
            normalizedItems = Array.isArray(body.items) ? body.items : [];
            if (!normalizedItems.length) {
                return res.status(400).json({ error: 'Your cart is empty.' });
            }
            amountJmd = normalizedItems.reduce(
                (sum, item) => sum + parsePriceToNumber(item && item.price),
                0
            );
        }

        if (!(amountJmd > 0)) {
            return res.status(400).json({ error: 'Invalid order total.' });
        }

        const orderId = `IVS-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const callbackUrl = `${APP_BASE_URL}/api/ncb/callback?orderId=${encodeURIComponent(orderId)}`;

        const orderRecord = {
            orderId,
            orderType,
            fulfillment: body.fulfillment || 'delivery',
            customerName,
            customerPhone,
            deliveryAddress: body.deliveryAddress || '',
            items: normalizedItems,
            eventType: body.eventType || '',
            eventDate: body.eventDate || '',
            estimatedGuests: body.estimatedGuests || '',
            packageName: body.packageName || 'Space Rental Only (JMD $45,000)',
            whatsappNumber: body.whatsappNumber || DEFAULT_WHATSAPP_NUMBER,
            amountJmd,
            status: 'pending'
        };

        pendingOrders.set(orderId, orderRecord);

        const powerTranzPayload = {
            TransactionIdentifier: crypto.randomUUID(),
            TotalAmount: Number(amountJmd.toFixed(2)),
            CurrencyCode: '388', // JMD
            ThreeDSecure: true,
            OrderIdentifier: orderId,
            PageResponseUrl: callbackUrl,
            BillingAddress: {
                FirstName: customerName.split(' ')[0] || customerName,
                LastName: customerName.split(' ').slice(1).join(' ') || 'Customer',
                Phone: customerPhone
            },
            ExtendedData: {
                ThreeDSecure: {
                    ChallengeWindowSize: 4
                },
                MerchantResponseUrl: callbackUrl
            }
        };

        const ptResponse = await fetch(`${POWERTRANZ_API_URL}/spi/sale`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'PowerTranz-PowerTranzId': POWERTRANZ_ID,
                'PowerTranz-PowerTranzPassword': POWERTRANZ_PASSWORD
            },
            body: JSON.stringify(powerTranzPayload)
        });

        const ptData = await ptResponse.json().catch(() => ({}));

        if (!ptResponse.ok) {
            return res.status(502).json({
                error: ptData.ResponseMessage || 'Failed to initialize NCB payment session.'
            });
        }

        // PowerTranz returns RedirectHtml (for 3DS / HPP form auto-submit) or RedirectUrl
        if (ptData.RedirectHtml) {
            return res.json({ orderId, redirectHtml: ptData.RedirectHtml });
        }

        if (ptData.RedirectUrl) {
            return res.json({ orderId, redirectUrl: ptData.RedirectUrl });
        }

        if (ptData.IsoResponseCode === '00') {
            orderRecord.status = 'paid';
            return res.json({
                orderId,
                redirectUrl: buildWhatsAppRedirectUrl(orderRecord)
            });
        }

        return res.status(400).json({
            error: ptData.ResponseMessage || 'Payment could not be initiated.'
        });
    } catch (err) {
        console.error('Error in /api/ncb/create-payment:', err);
        return res.status(500).json({ error: 'Server error creating NCB payment.' });
    }
});

// NCB / PowerTranz Payment Callback & Return Handler
async function handleNcbCallback(req, res) {
    try {
        const payload = { ...(req.query || {}), ...(req.body || {}) };
        const orderId = String(payload.orderId || payload.OrderIdentifier || '').trim();
        const order = pendingOrders.get(orderId) || {
            orderId: orderId || 'NCB-ORDER',
            orderType: 'food_order',
            amountJmd: parsePriceToNumber(payload.TotalAmount),
            whatsappNumber: DEFAULT_WHATSAPP_NUMBER
        };

        // If a SpiToken is returned from 3DS challenge, complete/verify payment with /spi/payment
        let finalTxn = payload;
        if (payload.SpiToken && POWERTRANZ_ID && POWERTRANZ_PASSWORD) {
            const settleRes = await fetch(`${POWERTRANZ_API_URL}/spi/payment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'PowerTranz-PowerTranzId': POWERTRANZ_ID,
                    'PowerTranz-PowerTranzPassword': POWERTRANZ_PASSWORD
                },
                body: JSON.stringify(payload.SpiToken)
            });
            const settleData = await settleRes.json().catch(() => null);
            if (settleData && typeof settleData === 'object') {
                finalTxn = { ...payload, ...settleData };
            }
        }

        const approved = finalTxn.IsoResponseCode === '00' || finalTxn.Approved === true;

        if (approved) {
            order.status = 'paid';
            pendingOrders.set(order.orderId, order);
            return res.redirect(302, buildWhatsAppRedirectUrl(order));
        }

        order.status = 'declined';
        pendingOrders.set(order.orderId, order);
        const msg = encodeURIComponent(
            finalTxn.ResponseMessage || 'Your NCB card payment was not approved. Please try again.'
        );
        return res.redirect(302, `${APP_BASE_URL}/?ncbStatus=failed&message=${msg}`);
    } catch (err) {
        console.error('Error in /api/ncb/callback:', err);
        return res.redirect(302, `${APP_BASE_URL}/?ncbStatus=error`);
    }
}

app.post('/api/ncb/callback', handleNcbCallback);
app.get('/api/ncb/callback', handleNcbCallback);

// API Health Check Route
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'online', 
        message: 'Island Vibz Seafood backend is running successfully!',
        timestamp: new Date().toISOString()
    });
});

// Catch-all route to serve index.html for single-page layout handling
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`Island Vibz backend server running locally on http://localhost:${PORT}`);
});
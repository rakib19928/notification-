require('dotenv').config();
const admin = require('firebase-admin');
const axios = require('axios');
const express = require('express');

// ১. রেলওয়ে হেলথ চেক সার্ভার
const app = express();
const PORT = process.env.PORT || 8080;
app.get('/', (req, res) => res.send('Bot Status: Active'));
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));

// ২. এনভায়রনমেন্ট ভেরিয়েবল লোড
if (!process.env.FIREBASE_SERVICE) throw new Error("Missing FIREBASE_SERVICE env variable");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE);

if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN env variable");
const BOT_TOKEN = process.env.BOT_TOKEN;

// ৩. Firebase initialize
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// টাইমস্ট্যাম্প ফরম্যাট
function formatTime(timestamp) {
  if (timestamp && timestamp.seconds) {
    return new Date(timestamp.seconds * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });
  }
  return new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });
}

// টেলিগ্রাম মেসেজ ফাংশন
async function sendTelegramMessage(chatId, message) {
  try {
    const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: message
    });
    return res.data.ok;
  } catch (err) {
    console.error('❌ Telegram error:', err.response?.data || err.message);
    return false;
  }
}

// ৪. মেইন ইভেন্ট প্রসেসর
async function processEvent(data, docId, collectionName) {
  // region এর সাথে reason যোগ করা হলো
  const { status, method, amount, trxId, requestId, notified, bankid, note, region, reason, name } = data;

  if (!status || !method) return;
  if (notified === status) return;
  if (!['pending', 'approved', 'rejected'].includes(status)) return;

  const number = data.Number || data.number || 'N/A';
  const customId = data.id || docId;
  const isWithdraw = collectionName === 'withdrawRequests';

  try {
    const snap = await db.collection('musers').where('payment', '==', method).get();
    if (snap.empty) {
        console.log(`⚠️ No manager found for method: ${method}`);
        return;
    }

    const manager = snap.docs[0].data();
    const chatId = manager.chatId;
    if (!chatId) return;

    let msg = '';

    if (!isWithdraw) {
      // ==== ডিপোজিট সেকশন ====
      const bdtAmount = parseFloat(amount);
      const formattedBDT = bdtAmount.toFixed(2);

      if (status === 'approved') {
        msg = `APPROVED 
BankTransfer Agents
Deposit Request № ${requestId || 'N/A'}
Agent: ${method}
Payment number: ${number}
Amount: ${bdtAmount} BDT
Customer: ${customId}
Ext_trn_id: ${trxId || 'N/A'}`;

      } else if (status === 'pending') {
        msg = `BankTransfer Agents
Deposit Request № ${requestId || 'N/A'}
Agent:  ${method} 
Payment number: ${number}
Amount: ${formattedBDT} BDT 
Customer: ${customId}
ChatId - ${chatId}
id: ${bankid || 'N/A'}
ext_trn_id: ${trxId || 'N/A'}
${note || ''}`;

      } else {
        msg = `REJECTED
BankTransfer Agents
Deposit Request № ${requestId || 'N/A'}
Agent: ${method}
Payment number: ${number}
Amount: ${formattedBDT} BDT 
Customer: ${customId}
BankTransferComment: ${region || 'N/A'}
Ext_trn_id: ${trxId || 'N/A'}`;
      }

    } else {
      // ==== উইথড্র সেকশন ====
      if (status === 'approved') {
        // ✅ SENT (Approved) ফরম্যাট
        msg = `SENT
BankTransfer Agents
Withdrawal Request № ${requestId || 'N/A'}
Agent: ${method}
Payment number: ${number}
Amount: ${amount} BDT
Customer: ${customId} ${name || ''}
BankTransferComment: ${trxId || 'N/A'}`;

      } else if (status === 'pending') {
        // ⏳ PENDING ফরম্যাট
        msg = `BankTransfer Agents
Withdrawal Request № ${requestId || 'N/A'}
Agent: ${method}
Payment number: ${number}
Amount: ${amount} BDT 
Customer: ${customId} (${name || 'N/A'})
- User data -
id: ${bankid || 'N/A'}
${note || 'Wallet Number'}: ${number}`;

      } else {
        // ❌ REJECTED (CANCELED) ফরম্যাট [UPDATED]
        // এখানে region এর বদলে reason ব্যবহার করা হয়েছে
        msg = `CANCELED
BankTransfer Agents
Withdrawal Request № ${requestId || 'N/A'}
Agent: ${method}
Payment number: ${number}
Amount: ${amount} BDT 
Customer: ${customId} ${name || ''}
BankTransferComment: ${reason || 'N/A'}`;
      }
    }

    const sent = await sendTelegramMessage(chatId, msg);

    if (sent) {
      await db.collection(collectionName).doc(docId).update({
        notified: status
      });
      console.log(`✅ Notification updated for ${docId} [${status}]`);
    }
  } catch (err) {
    console.error('❌ Error processing event:', err.message);
  }
}

// ৫. লিসেনারস
db.collection('depositRequests').onSnapshot(snap => {
  snap.docChanges().forEach(change => {
    if (change.type === 'added' || change.type === 'modified') {
      processEvent(change.doc.data(), change.doc.id, 'depositRequests');
    }
  });
}, err => console.error("Deposit Listener Err:", err));

db.collection('withdrawRequests').onSnapshot(snap => {
  snap.docChanges().forEach(change => {
    if (change.type === 'added' || change.type === 'modified') {
      processEvent(change.doc.data(), change.doc.id, 'withdrawRequests');
    }
  });
}, err => console.error("Withdraw Listener Err:", err));

console.log('🚀 Bot is running and Railway health check is active...');

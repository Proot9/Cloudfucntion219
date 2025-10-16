// Script function 
// Import Firebase Admin SDK (untuk interaksi database dan inisialisasi)
const admin = require('firebase-admin');
const functions = require('firebase-functions');
// Import library Midtrans
const midtransClient = require('midtrans-client');

// Inisialisasi Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Ambil Kunci Rahasia dan Environment (Sandbox/Production) dari Environment Variables
// PENTING: Kunci ini harus di-set menggunakan perintah firebase functions:config:set
const MIDTRANS_SECRET_KEY = process.env.MIDTRANS_SECRET_KEY; 
const isProduction = process.env.NODE_ENV === 'production';

// Inisialisasi Midtrans Snap API (untuk membuat token)
const snap = new midtransClient.Snap({
    isProduction: isProduction,
    serverKey: MIDTRANS_SECRET_KEY
});

// Inisialisasi Midtrans Core API (untuk Webhook/Notifikasi)
const coreApi = new midtransClient.CoreApi({
    isProduction : isProduction,
    serverKey : MIDTRANS_SECRET_KEY
});


// =========================================================================
// FUNGSI 1: createTransaction (DIPANGGIL DARI FRONTEND)
// =========================================================================

exports.createTransaction = functions.https.onCall(async (data, context) => {
    
    // --- 1. Validasi Keamanan (Minimal) ---
    // (Tambahkan validasi user login jika diperlukan, menggunakan context.auth)
    if (!data.amount || data.amount <= 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Amount must be greater than zero.');
    }
    
    // --- 2. Siapkan Data Transaksi ---
    const grossAmount = data.amount;
    const uniqueOrderId = `ORDER-${Date.now()}-${Math.floor(Math.random() * 9000) + 1000}`; // ID Unik
    
    const parameter = {
        transaction_details: {
            order_id: uniqueOrderId,
            gross_amount: grossAmount,
        },
        credit_card: {
            secure: true // Memastikan 3D Secure aktif
        },
        customer_details: {
            first_name: data.customerName || 'Androlin Guest',
            email: data.customerEmail || 'support@androlinstore.com',
            // Tambahkan alamat, nomor telepon jika tersedia
        },
        // Anda bisa tambahkan item_details di sini
    };

    try {
        // --- 3. Panggil API Midtrans untuk mendapatkan Snap Token ---
        const transaction = await snap.createTransaction(parameter);
        
        // --- 4. Simpan Status Awal ke Database (Firestore) ---
        await db.collection('transactions').doc(uniqueOrderId).set({
            userId: context.auth ? context.auth.uid : 'guest',
            status: 'PENDING',
            amount: grossAmount,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            snapToken: transaction.token,
            // Simpan detail produk, dll.
        });
        
        // --- 5. Kembalikan token ke Frontend ---
        return {
            token: transaction.token,
            orderId: uniqueOrderId
        };

    } catch (error) {
        console.error("Error creating Midtrans transaction:", error);
        throw new functions.https.HttpsError('internal', 'Failed to create transaction with Midtrans.', error.message);
    }
});


// =========================================================================
// FUNGSI 2: midtransNotification (WEBHOOK DARI MIDTRANS)
// =========================================================================

exports.midtransNotification = functions.https.onRequest(async (req, res) => {
    
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const notificationData = req.body;
        const orderId = notificationData.order_id;
        
        // --- 1. Verifikasi Notifikasi (KRITIS) ---
        // Midtrans library akan otomatis memverifikasi signature dan mengambil status terbaru
        const statusResponse = await coreApi.transaction.notification(notificationData);
        
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        // --- 2. Tentukan Status Akhir ---
        let newOrderStatus;
        if (transactionStatus === 'capture' && fraudStatus === 'accept') {
            newOrderStatus = 'SUCCESS'; // Kartu Kredit yang diterima
        } else if (transactionStatus === 'settlement') {
            newOrderStatus = 'SUCCESS'; // Non-Kartu Kredit (Transfer, E-Wallet)
        } else if (transactionStatus === 'pending') {
            newOrderStatus = 'PENDING';
        } else if (['deny', 'cancel', 'expire', 'failure'].includes(transactionStatus)) {
            newOrderStatus = 'FAILED';
        } else {
            newOrderStatus = 'CHALLENGE';
        }

        // --- 3. Update Database (Hanya jika status berubah) ---
        if (newOrderStatus) {
            await db.collection('transactions').doc(orderId).update({
                status: newOrderStatus,
                paid_at: admin.firestore.FieldValue.serverTimestamp(),
                rawMidtransStatus: statusResponse,
            });
        }

        // --- 4. Respon Wajib (200 OK) ---
        return res.status(200).send('Notification Handled');

    } catch (error) {
        console.error("Error processing Midtrans notification:", error);
        // Respon selain 200 akan memicu Midtrans untuk mencoba mengirim ulang (retry)
        return res.status(500).send('Error'); 
    }
});

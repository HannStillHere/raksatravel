const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Unhandled exception guards to prevent process exit
process.on('uncaughtException', (err) => {
  console.error('⚠️ [UNCAUGHT EXCEPTION]:', err.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [UNHANDLED REJECTION]:', reason?.message || reason);
});

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 7860;
const GITHUB_REPO = process.env.GITHUB_REPO || 'HannStillHere/raksatravel.github.io';
const TARGET_CHANNEL_CODE = '0029VbCYmHQ9WtBxoi1pjH0f';
let TARGET_CHANNEL_JID = '120363413097453454@newsletter';

let GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
try {
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (cfg.GITHUB_TOKEN) GITHUB_TOKEN = cfg.GITHUB_TOKEN;
  }
} catch (e) {}

let latestQrDataUrl = '';
let latestQrRaw = '';
let authStatus = 'Menunggu Inisialisasi WhatsApp Cloud...';
let isConnected = false;
let syncLogHistory = [];
let watchdogInterval = null;
let metadataRetryInterval = null;
let isProcessingQueue = false;
let globalSock = null;

// Persistent processed messages file
const PROCESSED_DB_FILE = path.join(__dirname, 'processed_messages.json');
let processedMessageIds = new Set();

try {
  if (fs.existsSync(PROCESSED_DB_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PROCESSED_DB_FILE, 'utf-8'));
    if (Array.isArray(raw)) {
      processedMessageIds = new Set(raw);
    }
  }
} catch (e) {
  processedMessageIds = new Set();
}

function saveProcessedMessageId(msgId) {
  if (!msgId) return;
  processedMessageIds.add(msgId);
  try {
    const arr = Array.from(processedMessageIds).slice(-300); // keep last 300 IDs
    fs.writeFileSync(PROCESSED_DB_FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (e) {}
}

function logSync(msg) {
  const timeStr = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jayapura' });
  console.log(`[${timeStr}] ${msg}`);
  syncLogHistory.unshift(`[${timeStr}] ${msg}`);
  if (syncLogHistory.length > 50) syncLogHistory.pop();
}

console.log('====================================================');
console.log('🤖 RAKSA TRAVEL - 24/7 AUTO CLOUD BAILEYS BOT');
console.log(' Channel Target:', TARGET_CHANNEL_CODE);
console.log(' GitHub Target: ', GITHUB_REPO);
console.log('====================================================\n');

// 1. IATA Airport & City Reference Map
const IATA_MAP = {
  'jayapura': 'DJJ',
  'makassar': 'UPG',
  'surabaya': 'SUB',
  'jakarta': 'CGK',
  'denpasar': 'DPS',
  'bali': 'DPS',
  'timika': 'TIM',
  'biak': 'BIK',
  'sorong': 'SOQ',
  'merauke': 'MKQ',
  'manokwari': 'MKW',
  'nabire': 'NBX',
  'ambon': 'AMQ',
  'yogyakarta': 'YIA',
  'jogja': 'YIA',
  'semarang': 'SRG',
  'balikpapan': 'BPN',
  'manado': 'MDC',
  'medan': 'KNO',
  'palembang': 'PLM',
  'padang': 'PDG',
  'pekanbaru': 'PKU',
  'batam': 'BTH',
  'pontianak': 'PNK',
  'banjarmasin': 'BDJ',
  'kendari': 'KDI',
  'gorontalo': 'GTO',
  'palu': 'PLW',
  'ternate': 'TTE',
  'kupang': 'KOE',
  'labuan bajo': 'LBJ',
  'lombok': 'LOP'
};

function resolveIataCode(cityName, defaultCode = 'DJJ') {
  if (!cityName) return defaultCode;
  const clean = cityName.toLowerCase().trim();
  for (const [city, code] of Object.entries(IATA_MAP)) {
    if (clean.includes(city)) return code;
  }
  return defaultCode;
}

// 2. High-Accuracy AI Vision Multimodal OCR with Multi-Model Cascade
async function analyzeImageWithAiVision(base64Data, captionHint = '') {
  const prompt = `Anda adalah AI Vision & OCR Engine tingkat tinggi spesialis membaca poster promo tiket pesawat & kapal laut resmi untuk Raksa Travel.

TUGAS UTAMA:
Lakukan pemindaian visual OCR ultra-teliti dari gambar poster tiket promo ini.
${captionHint ? `Petunjuk Teks Tambahan dari Pengirim/Caption: "${captionHint}"` : ''}

ATURAN VALIDASI KETAT TEMPLATE RAKSA TRAVEL:
1. Jika gambar BUKAN poster promo tiket perjalanan/penerbangan/kapal laut resmi (misalnya: foto orang, foto pemandangan, cosplay, anime, manga, meme, screenshot chat WA, struk, bukti transfer, video/youtube thumbnail, atau gambar non-promo), KEMBALIKAN JSON PERSIS:
{"is_valid": false}

2. Poster promo tiket resmi Raksa Travel HARUS MEMILIKI FORMAT TEMPLATE RESMI:
- Logo / nama maskapai penerbangan (LION AIR, BATIK AIR, GARUDA INDONESIA, CITILINK, SRIWIJAYA AIR, SUPER AIR JET, WINGS AIR) atau kapal PELNI.
- Rute penerbangan jelas: Kota Asal dan Kota Tujuan (contoh: DJJ - CGK, JAYAPURA - SURABAYA, MAKASSAR - JAYAPURA, UPG - DJJ, SUB - DJJ, dll).
- Harga promo tiket yang jelas (contoh: Rp 3.695.000, Rp 2.360.000, dll dengan nominal > Rp 500.000).
- Tanggal/periode keberangkatan (contoh: 17, 18, 22 Okt, dll).
Jika salah satu dari elemen penting ini TIDAK ADA pada gambar, gambar tersebut BUKAN POSTER PROMO RESMI. Kembalikan {"is_valid": false}.

3. Jika gambar MEMENUHI seluruh syarat poster promo tiket resmi di atas, ekstrak datanya dalam format JSON murni:
{
  "is_valid": true,
  "badge": "Nama maskapai/operator resmi dalam huruf kapital (contoh: LION AIR, BATIK AIR, SRIWIJAYA AIR, CITILINK, GARUDA INDONESIA, SUPER AIR JET, WINGS AIR, PELNI, KM LABOBAR, KM DOBONSOLO)",
  "badgeType": "airline atau ship",
  "origin": "Nama kota asal keberangkatan (contoh: Jayapura, Makassar, Surabaya, Jakarta, Denpasar, Timika, Biak, Sorong, Nabire, Merauke)",
  "originCode": "Kode bandara asal 3 huruf resmi IATA (contoh: DJJ, UPG, SUB, CGK, DPS, TIM, BIK, SOQ, NBX, MKQ)",
  "destination": "Nama kota tujuan (contoh: Makassar, Jayapura, Surabaya, Jakarta, Denpasar, Timika, Biak, Sorong, Nabire, Merauke)",
  "destinationCode": "Kode bandara tujuan 3 huruf resmi IATA (contoh: UPG, DJJ, SUB, CGK, DPS, TIM, BIK, SOQ, NBX, MKQ)",
  "transit": "Tipe rute persis (contoh: Penerbangan Langsung / Penerbangan Transit / Transit Makassar / Transit Surabaya / Transit 1X / Kapal Laut Langsung)",
  "price": "Nominal harga termurah (HANYA ANGKA dengan pemisah titik ribuan, tanpa kata Rp, contoh: 2.220.000 / 2.290.000 / 3.305.000 / 3.475.000 / 3.695.000 / 1.850.000)",
  "date": "Daftar tanggal/periode jadwal keberangkatan persis seperti di poster (contoh: 17, 18, 22 Okt / Tgl 19 s/d 29 Oktober)",
  "baggage": "Keterangan jatah bagasi resmi (contoh: Termasuk Bagasi 10 KG / Termasuk Bagasi 15 KG / Termasuk Bagasi 20 KG / Free Bagasi Kabin 7 KG / Tanpa Bagasi)",
  "phone": "Nomor kontak WhatsApp yang tertera di poster jika ada (contoh: 082153043601)"
}

PANDUAN PEMBACAAN OCR:
- Periksa angka harga, rute asal-tujuan, dan daftar tanggal keberangkatan dengan sangat cermat.
- Jangan tertukar antara kota asal (Origin) dan kota tujuan (Destination). Perhatikan tanda panah (-> atau -) pada poster.
- HANYA KEMBALIKAN JSON VALID MURNI TANPA MARKDOWN / PENJELASAN.`;

  const fallbackModels = [
    'ag/gemini-3.7-flash-high',
    'cx/gpt-5.6-luna-review',
    'gemini/gemini-3.8-flash',
    'gemini/gemini-2.5-pro',
    'groq/deepseek-r1-distill-llama-70b'
  ];

  for (const modelName of fallbackModels) {
    try {
      const res = await fetch('http://127.0.0.1:20128/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sk-314fd95655a96de0-jnhrcd-d8fe965d'
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`,
                    detail: 'high'
                  }
                }
              ]
            }
          ],
          stream: false,
          temperature: 0.05
        })
      });

      if (res.ok) {
        const textRes = await res.text();
        let content = '';

        try {
          const jsonRes = JSON.parse(textRes);
          content = jsonRes.choices?.[0]?.message?.content || '';
        } catch {
          for (const line of textRes.split('\n')) {
            if (line.startsWith('data:') && !line.includes('[DONE]')) {
              try {
                const chunk = JSON.parse(line.replace('data:', '').trim());
                content += chunk.choices?.[0]?.delta?.content || '';
              } catch (e) {}
            }
          }
        }

        content = content.replace(/```json/gi, '').replace(/```/g, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        const data = JSON.parse(jsonMatch[0]);

        if (data.is_valid !== true || !data.origin || !data.destination || !data.price) {
          console.log(`⚠️ AI Vision (${modelName}): Gambar BUKAN poster promo resmi atau rute/harga tidak lengkap.`);
          continue;
        }

        let cleanPrice = String(data.price).replace(/Rp\.?\s*/i, '').replace(/,/g, '.').replace(/[^\d.]/g, '').trim();
        // Jika angka polos tanpa titik (misal 2290000), format ke 2.290.000
        if (/^\d{6,8}$/.test(cleanPrice)) {
          cleanPrice = Number(cleanPrice).toLocaleString('id-ID');
        }

        const numPrice = parseInt(cleanPrice.replace(/\./g, ''), 10);
        if (isNaN(numPrice) || numPrice < 500000) {
          console.log(`⚠️ AI Vision (${modelName}): Harga tidak valid (< 500.000): ${cleanPrice}`);
          continue;
        }

        let badgeName = (data.badge || '').toUpperCase();
        if (badgeName.includes('LION')) badgeName = 'LION AIR';
        else if (badgeName.includes('BATIK')) badgeName = 'BATIK AIR';
        else if (badgeName.includes('SRIWIJAYA')) badgeName = 'SRIWIJAYA AIR';
        else if (badgeName.includes('GARUDA')) badgeName = 'GARUDA INDONESIA';
        else if (badgeName.includes('CITILINK')) badgeName = 'CITILINK';
        else if (badgeName.includes('SUPER') && badgeName.includes('AIR')) badgeName = 'SUPER AIR JET';
        else if (badgeName.includes('WINGS')) badgeName = 'WINGS AIR';
        else if (badgeName.includes('PELNI') || badgeName.includes('KM ') || badgeName.includes('KAPAL')) badgeName = 'PELNI';
        else {
          console.log(`⚠️ AI Vision (${modelName}): Maskapai/operator tidak dikenal (${data.badge}), ditolak.`);
          continue;
        }

        const originCode = data.originCode || resolveIataCode(data.origin, 'DJJ');
        const destCode = data.destinationCode || resolveIataCode(data.destination, 'UPG');

        console.log(`✨ [AI VISION VALIDASI SUKSES via ${modelName}]: ${badgeName} | ${data.origin} (${originCode}) -> ${data.destination} (${destCode}) | Rp ${cleanPrice}`);

        return {
          id: `promo-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          badge: badgeName,
          badgeType: badgeName === 'PELNI' ? 'ship' : 'airline',
          airlineLogo: badgeName === 'PELNI' ? 'ship' : 'plane',
          origin: data.origin,
          originCode: originCode,
          destination: data.destination,
          destinationCode: destCode,
          transit: data.transit || 'Penerbangan Langsung',
          price: cleanPrice,
          date: data.date || 'Keberangkatan Terdekat',
          baggage: data.baggage || 'Termasuk Bagasi',
          waText: encodeURIComponent(`Halo RaksaTravel, saya mau ambil tiket promo ${badgeName} ${data.origin} - ${data.destination} Rp ${cleanPrice} (${data.date || ''})`)
        };
      }
    } catch (err) {
      console.log(`AI Vision error on ${modelName}:`, err.message);
    }
  }

  // Strict Regex Fallback ONLY IF caption contains complete verified promo details
  if (captionHint) {
    const text = captionHint.toUpperCase();
    const priceMatch = text.match(/(?:RP\.?\s*)?(\d{1,3}(?:\.\d{3})+)/);
    if (priceMatch) {
      const numVal = parseInt(priceMatch[1].replace(/\./g, ''), 10);
      if (numVal >= 500000) {
        let badge = null;
        if (text.includes('LION')) badge = 'LION AIR';
        else if (text.includes('BATIK')) badge = 'BATIK AIR';
        else if (text.includes('SRIWIJAYA')) badge = 'SRIWIJAYA AIR';
        else if (text.includes('CITILINK')) badge = 'CITILINK';
        else if (text.includes('GARUDA')) badge = 'GARUDA INDONESIA';
        else if (text.includes('SUPER AIR JET')) badge = 'SUPER AIR JET';
        else if (text.includes('PELNI') || text.includes('KAPAL')) badge = 'PELNI';

        if (badge) {
          let origin = null;
          let dest = null;
          if (text.includes('MAKASSAR - JAYAPURA') || text.includes('MAKASSAR KE JAYAPURA') || text.includes('UPG - DJJ') || text.includes('UPG KE DJJ')) {
            origin = 'Makassar'; dest = 'Jayapura';
          } else if (text.includes('JAYAPURA - MAKASSAR') || text.includes('JAYAPURA KE MAKASSAR') || text.includes('DJJ - UPG') || text.includes('DJJ KE UPG')) {
            origin = 'Jayapura'; dest = 'Makassar';
          } else if (text.includes('SURABAYA - JAYAPURA') || text.includes('SUB - DJJ')) {
            origin = 'Surabaya'; dest = 'Jayapura';
          } else if (text.includes('JAYAPURA - SURABAYA') || text.includes('DJJ - SUB')) {
            origin = 'Jayapura'; dest = 'Surabaya';
          } else if (text.includes('JAKARTA - JAYAPURA') || text.includes('CGK - DJJ')) {
            origin = 'Jakarta'; dest = 'Jayapura';
          } else if (text.includes('JAYAPURA - JAKARTA') || text.includes('DJJ - CGK')) {
            origin = 'Jayapura'; dest = 'Jakarta';
          }

          if (origin && dest) {
            console.log(`⚡ [STRICT CAPTION EXTRACTED]: ${badge} ${origin}-${dest} Rp ${priceMatch[1]}`);
            return {
              id: `promo-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
              badge: badge,
              badgeType: badge === 'PELNI' ? 'ship' : 'airline',
              airlineLogo: badge === 'PELNI' ? 'ship' : 'plane',
              origin: origin,
              originCode: resolveIataCode(origin, 'DJJ'),
              destination: dest,
              destinationCode: resolveIataCode(dest, 'UPG'),
              transit: text.includes('TRANSIT') ? 'Penerbangan Transit' : 'Penerbangan Langsung',
              price: priceMatch[1],
              date: 'Keberangkatan Terdekat',
              baggage: 'Termasuk Bagasi',
              waText: encodeURIComponent(`Halo RaksaTravel, saya mau ambil tiket promo ${badge} ${origin} - ${dest} Rp ${priceMatch[1]}`)
            };
          }
        }
      }
    }
  }

  return null;
}

// 2. Atomic GitHub REST API Committer with Retry on 409 Conflict
async function commitPromosToGitHub(newPromo) {
  if (!GITHUB_TOKEN) return false;

  const fileUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/promos.json`;
  const ghHeaders = {
    'User-Agent': 'Raksa-Baileys-Cloud-Bot',
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  // Also update local file if exists
  try {
    const localPath = path.join(__dirname, '..', 'promos.json');
    if (fs.existsSync(localPath)) {
      let localList = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      const existingIdx = localList.findIndex(p => p.badge === newPromo.badge && p.origin === newPromo.origin && p.destination === newPromo.destination);
      if (existingIdx !== -1) {
        localList.splice(existingIdx, 1);
      }
      localList.unshift(newPromo);
      localList = localList.slice(0, 12);
      fs.writeFileSync(localPath, JSON.stringify(localList, null, 2), 'utf-8');
    }
  } catch (e) {}

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let currentPromos = [];
      let sha = '';
      const getRes = await fetch(fileUrl, { headers: ghHeaders });
      if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha || '';
        const decoded = Buffer.from(fileData.content, 'base64').toString('utf-8');
        currentPromos = JSON.parse(decoded);
      }

      const isExactDuplicate = currentPromos.some(p => p.badge === newPromo.badge && p.origin === newPromo.origin && p.destination === newPromo.destination && p.price === newPromo.price && p.date === newPromo.date);
      if (isExactDuplicate) {
        console.log('ℹ️ Promo ini sudah terdaftar persis di promos.json. Melewati duplikat.');
        return true;
      }

      const existingIdx = currentPromos.findIndex(p => p.badge === newPromo.badge && p.origin === newPromo.origin && p.destination === newPromo.destination);
      if (existingIdx !== -1) {
        console.log(`🔄 Menggantikan promo lama (${currentPromos[existingIdx].badge} ${currentPromos[existingIdx].origin}-${currentPromos[existingIdx].destination} Rp ${currentPromos[existingIdx].price}) dengan promo terbaru (Rp ${newPromo.price})...`);
        currentPromos.splice(existingIdx, 1);
      }

      currentPromos.unshift(newPromo);
      currentPromos = currentPromos.slice(0, 12);
      const updatedJson = JSON.stringify(currentPromos, null, 2);

      const putRes = await fetch(fileUrl, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `auto: live promo update [${newPromo.badge} ${newPromo.origin}-${newPromo.destination}] from Cloud Baileys Bot`,
          content: Buffer.from(updatedJson).toString('base64'),
          sha: sha || undefined
        })
      });

      if (putRes.ok) {
        console.log(`🎉 [GITHUB PUSH] Sukses update promos.json di website raksatravel.github.io!`);
        logSync(`Deploy Promo: ${newPromo.badge} ${newPromo.origin} -> ${newPromo.destination} (Rp ${newPromo.price})`);
        return true;
      } else if (putRes.status === 409) {
        console.warn(`⚠️ [GITHUB 409 CONFLICT] Retrying promos.json commit (attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      } else {
        const errText = await putRes.text();
        console.error(`❌ [GITHUB ERROR promos.json]: HTTP ${putRes.status} - ${errText}`);
        return false;
      }
    } catch (e) {
      console.error('Error committing to GitHub promos.json:', e.message);
    }
  }
  return false;
}

// 3. Helper: Compress image to optimized progressive MozJPEG (ultra HD clear text & vivid realism)
async function compressImageBuffer(inputBuffer) {
  try {
    return await sharp(inputBuffer)
      .rotate() // Auto-orient berdasarkan metadata EXIF
      .resize({
        width: 1400,
        height: 1400,
        fit: 'inside',
        withoutEnlargement: true
      })
      .sharpen({
        sigma: 1.0,
        m1: 0.7,
        m2: 0.2
      })
      .jpeg({
        quality: 88,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: '4:4:4'
      })
      .toBuffer();
  } catch (err) {
    console.error('⚠️ Kompresi sharp gagal, menggunakan buffer asli:', err.message);
    return inputBuffer;
  }
}

// 4. Upload Poster and update promo-posters.json with 409 Retry
async function uploadPosterToGitHub(base64ImageData, promoData, rawBuffer = null) {
  const timestamp = Date.now();
  const fileName = `images/promo-${timestamp}.jpeg`;

  // 1. Simpan salinan lokal jika folder website tersedia
  try {
    const localImgPath = path.join(__dirname, '..', fileName);
    const localImgDir = path.dirname(localImgPath);
    if (fs.existsSync(localImgDir)) {
      fs.writeFileSync(localImgPath, rawBuffer || Buffer.from(base64ImageData, 'base64'));
      console.log(`💾 [LOKAL] Poster disimpan: ${localImgPath}`);
    }

    const localPostersPath = path.join(__dirname, '..', 'promo-posters.json');
    if (fs.existsSync(localPostersPath)) {
      let localPosters = JSON.parse(fs.readFileSync(localPostersPath, 'utf-8'));
      const descText = promoData.price 
        ? `Rp ${promoData.price} • ${promoData.date} • ${promoData.transit} • ${promoData.baggage}`
        : `${promoData.date} • ${promoData.transit}`;
      
      const newPosterObj = {
        id: `poster-${timestamp}`,
        image: fileName,
        badge: promoData.badge || 'TIKET PROMO',
        badgeType: promoData.badgeType || 'airline',
        title: `${promoData.badge} ${promoData.origin} - ${promoData.destination}`,
        desc: descText,
        price: promoData.price || '',
        date: promoData.date || '',
        waText: promoData.waText || '',
        addedAt: new Date().toISOString()
      };

      const existingPosterIdx = localPosters.findIndex(p => 
        (p.badge === newPosterObj.badge && p.title.includes(promoData.origin) && p.title.includes(promoData.destination)) ||
        p.title === newPosterObj.title
      );
      if (existingPosterIdx !== -1) {
        localPosters.splice(existingPosterIdx, 1);
      }
      localPosters.unshift(newPosterObj);
      localPosters = localPosters.slice(0, 12);
      fs.writeFileSync(localPostersPath, JSON.stringify(localPosters, null, 2), 'utf-8');
      console.log(`💾 [LOKAL] promo-posters.json diperbarui.`);
    }
  } catch (err) {
    console.warn('Local save warning:', err.message);
  }

  if (!GITHUB_TOKEN) return false;

  const ghHeaders = {
    'User-Agent': 'Raksa-Baileys-Cloud-Bot',
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  try {
    // 1. Upload Poster Image
    const imgUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${fileName}`;
    const putImgRes = await fetch(imgUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `auto: upload poster promo kompresi [${promoData.badge} ${promoData.origin}-${promoData.destination}]`,
        content: base64ImageData
      })
    });

    if (!putImgRes.ok) {
      const errImg = await putImgRes.text();
      console.error(`❌ [GITHUB ERROR upload image]: HTTP ${putImgRes.status} - ${errImg}`);
      return false;
    }

    // 2. Update promo-posters.json with 409 Conflict Retry
    const postersUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/promo-posters.json`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let posters = [];
        let sha = '';
        const getRes = await fetch(postersUrl, { headers: ghHeaders });
        if (getRes.ok) {
          const fileData = await getRes.json();
          sha = fileData.sha || '';
          posters = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));
        }

        const descText = promoData.price 
          ? `Rp ${promoData.price} • ${promoData.date} • ${promoData.transit} • ${promoData.baggage}`
          : `${promoData.date} • ${promoData.transit}`;

        const newPoster = {
          id: `poster-${timestamp}`,
          image: fileName,
          badge: promoData.badge || 'TIKET PROMO',
          badgeType: promoData.badgeType || 'airline',
          title: `${promoData.badge} ${promoData.origin} - ${promoData.destination}`,
          desc: descText,
          price: promoData.price || '',
          date: promoData.date || '',
          waText: promoData.waText || '',
          addedAt: new Date().toISOString()
        };

        const isExactDup = posters.some(p => p.title === newPoster.title && p.price === newPoster.price && p.date === newPoster.date);
        if (isExactDup) {
          console.log('ℹ️ Poster ini sudah ada di promo-posters.json. Melewati upload poster.');
          return true;
        }

        const existingPosterIdx = posters.findIndex(p => 
          (p.badge === newPoster.badge && p.title.includes(promoData.origin) && p.title.includes(promoData.destination)) ||
          p.title === newPoster.title
        );
        if (existingPosterIdx !== -1) {
          console.log(`🔄 Menggantikan poster lama (${posters[existingPosterIdx].title}) dengan poster terbaru...`);
          posters.splice(existingPosterIdx, 1);
        }

        posters.unshift(newPoster);
        posters = posters.slice(0, 12);

        const putPostersRes = await fetch(postersUrl, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'auto: update poster gallery terkompresi dari Cloud Bot',
            content: Buffer.from(JSON.stringify(posters, null, 2)).toString('base64'),
            sha: sha || undefined
          })
        });

        if (putPostersRes.ok) {
          console.log(`🖼️ [GITHUB] Poster promo aktif di website: ${fileName}`);
          logSync(`Upload Poster: ${promoData.badge} ${promoData.origin}-${promoData.destination}`);
          return true;
        } else if (putPostersRes.status === 409) {
          console.warn(`⚠️ [GITHUB 409 CONFLICT] Retrying promo-posters.json (attempt ${attempt}/3)...`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        } else {
          const errP = await putPostersRes.text();
          console.error(`❌ [GITHUB ERROR promo-posters.json]: HTTP ${putPostersRes.status} - ${errP}`);
          return false;
        }
      } catch (err) {
        console.error('Error updating promo-posters.json:', err.message);
      }
    }
  } catch (err) {
    console.error('Error upload poster:', err.message);
  }
  return false;
}

// 5. Universal Message Parser & Worker
async function processMessageMedia(msg, sourceTag = 'EVENT') {
  const msgId = msg.key?.id;
  if (msgId && processedMessageIds.has(msgId)) {
    return;
  }
  if (msgId) {
    saveProcessedMessageId(msgId);
  }

  const msgObj = msg.message || {};
  const imgObj = msgObj.imageMessage || 
                 msgObj.viewOnceMessageV2?.message?.imageMessage ||
                 msgObj.viewOnceMessage?.message?.imageMessage ||
                 msgObj.documentWithCaptionMessage?.message?.imageMessage ||
                 msgObj.ephemeralMessage?.message?.imageMessage ||
                 msgObj.templateMessage?.hydratedTemplate?.imageMessage ||
                 msgObj.interactiveMessage?.header?.imageMessage ||
                 (msgObj.documentMessage?.mimetype?.startsWith('image/') ? msgObj.documentMessage : null);

  const captionHint = imgObj?.caption || 
                      msgObj.extendedTextMessage?.text || 
                      msgObj.conversation || 
                      '';

  if (imgObj) {
    console.log(`\n📥 [${sourceTag}] Poster Saluran Terdeteksi: ${msg.key?.remoteJid || TARGET_CHANNEL_JID} (ID: ${msgId})`);
    try {
      const rawBuffer = await downloadMediaMessage(msg, 'buffer', {});
      if (rawBuffer && rawBuffer.length > 1000) {
        console.log(`📦 Mengompres poster (Ukuran asli: ${(rawBuffer.length / 1024).toFixed(1)} KB)...`);
        const compressedBuffer = await compressImageBuffer(rawBuffer);
        console.log(`✨ Hasil kompresi: ${(compressedBuffer.length / 1024).toFixed(1)} KB (hemat ${((1 - compressedBuffer.length / rawBuffer.length) * 100).toFixed(0)}%)`);

        const base64Data = compressedBuffer.toString('base64');
        console.log('🤖 Ekstraksi metadata promo dengan AI Vision / OCR Engine...');
        const promoData = await analyzeImageWithAiVision(base64Data, captionHint);

        if (!promoData || !promoData.badge || !promoData.origin || !promoData.destination || !promoData.price) {
          console.log(`⛔ [DIABAIKAN] Gambar ID ${msgId} BUKAN poster promo tiket resmi Raksa Travel. Ditolak.`);
          return null;
        }

        console.log(`✅ [PROMO TERVALIDASI]: ${promoData.badge} | ${promoData.origin} -> ${promoData.destination} | Rp ${promoData.price}`);
        await commitPromosToGitHub(promoData);
        await uploadPosterToGitHub(base64Data, promoData, compressedBuffer);
        return promoData;
      }
    } catch (err) {
      console.error(`❌ Gagal mendownload / memproses gambar: ${err.message}`);
    }
  }
  return null;
}

// 6. Polling Watchdog for Newsletter (Guarantees 100% detection)
function startNewsletterWatchdog(sock) {
  if (watchdogInterval) clearInterval(watchdogInterval);

  const fetchChannelUpdates = async () => {
    if (!isConnected || typeof sock.newsletterFetchMessages !== 'function') return;
    if (isProcessingQueue) return;

    isProcessingQueue = true;
    try {
      const channelMsgs = await sock.newsletterFetchMessages(TARGET_CHANNEL_JID, 25);
      if (channelMsgs && channelMsgs.length > 0) {
        // Sort newest first to prioritize most recent uploads
        channelMsgs.sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
        for (const cMsg of channelMsgs) {
          const msgId = cMsg.key?.id;
          if (msgId && !processedMessageIds.has(msgId)) {
            await processMessageMedia(cMsg, 'WATCHDOG-POLL');
          }
        }
      }
    } catch (err) {
      // Channel silent catch
    } finally {
      isProcessingQueue = false;
    }
  };

  // Run immediately then every 15 seconds
  fetchChannelUpdates();
  watchdogInterval = setInterval(fetchChannelUpdates, 15000);
}

// 7. Connect Baileys WhatsApp WebSocket Engine
async function startWhatsAppBot() {
  const authDir = path.join(__dirname, 'baileys_auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  globalSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrRaw = qr;
      authStatus = 'Silakan Scan QR Code';
      isConnected = false;
      console.log('\n📱 [WHATSAPP QR CODE TERSEDIA]:');
      qrcodeTerminal.generate(qr, { small: true });

      try {
        latestQrDataUrl = await QRCode.toDataURL(qr, { width: 340, margin: 2 });
      } catch (e) {}
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      authStatus = `Terputus: ${lastDisconnect?.error?.message || 'Reconnecting...'}`;
      isConnected = false;
      if (watchdogInterval) clearInterval(watchdogInterval);
      if (metadataRetryInterval) clearInterval(metadataRetryInterval);
      console.log(`Connection closed due to:`, lastDisconnect?.error, `, reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(startWhatsAppBot, 5000);
      } else {
        authStatus = 'Logged Out. Silakan Scan QR Code Baru.';
        setTimeout(startWhatsAppBot, 5000);
      }
    } else if (connection === 'open') {
      authStatus = '✅ ONLINE 24/7 DI CLOUD VPS';
      isConnected = true;
      latestQrDataUrl = '';
      latestQrRaw = '';
      console.log('\n🎉 [WHATSAPP TERKONEKSI]: Bot aktif memantau saluran 24 jam nonstop!');

      // Dynamic Newsletter Resolver function
      const resolveNewsletter = async () => {
        try {
          if (typeof sock.newsletterMetadata === 'function') {
            const channelMeta = await sock.newsletterMetadata('invite', TARGET_CHANNEL_CODE);
            if (channelMeta && channelMeta.id) {
              TARGET_CHANNEL_JID = channelMeta.id;
              console.log(`📢 [CHANNEL DIPANTAU]: ${channelMeta.name || 'Raksa Travel'} (JID: ${TARGET_CHANNEL_JID})`);
              if (typeof sock.newsletterFollow === 'function') {
                try { await sock.newsletterFollow(TARGET_CHANNEL_JID); } catch (e) {}
                console.log(`✅ [AUTO-SUBSCRIBE]: Terhubung ke saluran promo WhatsApp!`);
              }
            }
          }
        } catch (err) {
          console.log(`ℹ️ [CHANNEL INFO]: Saluran terdaftar (${TARGET_CHANNEL_CODE})`);
        }
      };

      await resolveNewsletter();
      if (metadataRetryInterval) clearInterval(metadataRetryInterval);
      metadataRetryInterval = setInterval(resolveNewsletter, 300000); // verify channel metadata every 5 min

      // Start continuous channel watchdog
      startNewsletterWatchdog(sock);

      // Auto-sync 6 latest verified official promos on startup
      setTimeout(() => {
        syncLatestChannelPromos(40);
      }, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        const remoteJid = msg.key?.remoteJid || '';
        const participant = msg.key?.participant || '';
        const sender = `${remoteJid} ${participant}`;
        const isFromMe = msg.key?.fromMe === true;

        // AUTHORIZED SENDER / OWNER (RAKSA TRAVEL ADMIN: 082153043601)
        const isOwner = sender.includes('6282153043601') || sender.includes('082153043601') || 
                        sender.includes('6282199157389') || sender.includes('082199157389') || 
                        sender.includes('6283821089552') || isFromMe;

        // TARGET: Saluran Resmi WhatsApp RAKSA TRAVEL (0029VbCYmHQ9WtBxoi1pjH0f / @newsletter)
        const isFromTargetChannel = (remoteJid === TARGET_CHANNEL_JID) || 
                                   (remoteJid.endsWith('@newsletter'));

        if (isFromTargetChannel || isOwner) {
          await processMessageMedia(msg, isFromTargetChannel ? 'LIVE-CHANNEL' : 'OWNER-DIRECT');
        }
      } catch (err) {
        console.log('Error processing incoming message:', err.message);
      }
    }
  });
}

// 8. Express Web Server for Monitoring, Status & Manual Webhook Sync
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Raksa Travel 24/7 Cloud Baileys Bot</title>
      <style>
        body { background: #070d18; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; text-align: center; }
        .card { background: #0f1a2e; border: 2px solid #25D366; padding: 30px; border-radius: 20px; box-shadow: 0 10px 40px rgba(37, 211, 102, 0.2); max-width: 460px; width: 92%; }
        h1 { color: #25D366; margin-top: 0; font-size: 22px; }
        .badge { background: rgba(37, 211, 102, 0.2); color: #25D366; padding: 8px 16px; border-radius: 999px; font-weight: bold; display: inline-block; margin: 15px 0; }
        .qr-box { background: white; padding: 15px; border-radius: 12px; display: inline-block; margin: 15px 0; }
        .qr-box img { display: block; max-width: 100%; height: auto; }
        .btn-sync { background: #25D366; color: #070d18; font-weight: bold; border: none; padding: 12px 24px; border-radius: 10px; cursor: pointer; font-size: 14px; margin-top: 15px; transition: 0.2s; }
        .btn-sync:hover { background: #1eb956; transform: scale(1.02); }
        .log-box { text-align: left; background: #050a12; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 11px; max-height: 160px; overflow-y: auto; margin-top: 15px; border: 1px solid #1e293b; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Raksa Travel 24/7 Cloud Bot</h1>
        <div class="badge">${isConnected ? 'ONLINE 24/7 (BAILEYS CLOUD)' : authStatus}</div>
        
        ${latestQrDataUrl && !isConnected ? `
          <p>Scan QR Code berikut menggunakan aplikasi WhatsApp di HP kamu:</p>
          <div class="qr-box">
            <img src="${latestQrDataUrl}" alt="WhatsApp QR Code">
          </div>
        ` : ''}

        ${isConnected ? `
          <p style="color: #4ade80; font-size: 14px; line-height: 1.5;">Bot aktif memantau Saluran WhatsApp 24 jam nonstop.<br>Setiap promo baru yang di-upload akan otomatis dikompres, dianalisis AI, dan langsung di-push ke <b>raksatravel.github.io</b>.</p>
        ` : ''}

        <button class="btn-sync" onclick="triggerManualSync()">⚡ Force Check Promo Sekarang</button>

        <h3 style="margin-top: 20px; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8;">Riwayat Aktivitas Bot:</h3>
        <div class="log-box" id="logBox">
          ${syncLogHistory.length > 0 ? syncLogHistory.map(l => `<div>${l}</div>`).join('') : '<div>Menunggu promo baru dari saluran...</div>'}
        </div>
      </div>

      <script>
        async function triggerManualSync() {
          const btn = document.querySelector('.btn-sync');
          btn.innerText = '⏳ Sedang Memeriksa Saluran...';
          btn.disabled = true;
          try {
            let res = await fetch('/wa/promo/api/sync', { method: 'POST' }).catch(() => null);
            if (!res || !res.ok) {
              res = await fetch('/api/sync', { method: 'POST' });
            }
            const data = await res.json();
            alert(data.message || 'Sinkronisasi berhasil dijalankan!');
            window.location.reload();
          } catch (e) {
            alert('Gagal memicu sinkronisasi: ' + e.message);
          } finally {
            btn.innerText = '⚡ Force Check Promo Sekarang';
            btn.disabled = false;
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.get('/status', (req, res) => {
  res.json({
    online: isConnected,
    status: authStatus,
    targetChannelCode: TARGET_CHANNEL_CODE,
    targetChannelJid: TARGET_CHANNEL_JID,
    processedCount: processedMessageIds.size,
    recentLogs: syncLogHistory.slice(0, 10),
    hasQr: !!latestQrRaw
  });
});

app.get('/qr', (req, res) => {
  res.json({
    online: isConnected,
    status: authStatus,
    qr: latestQrRaw,
    qrDataUrl: latestQrDataUrl
  });
});

async function syncLatestChannelPromos(limit = 40) {
  if (!globalSock || !isConnected) {
    console.log('⚠️ WhatsApp bot belum terkoneksi.');
    return { ok: false, message: 'WhatsApp bot belum terkoneksi.' };
  }
  logSync(`Memulai auto-sync 6 promo resmi dari saluran WhatsApp (${TARGET_CHANNEL_JID})...`);
  try {
    const channelMsgs = await globalSock.newsletterFetchMessages(TARGET_CHANNEL_JID, limit);
    if (!channelMsgs || channelMsgs.length === 0) {
      logSync('Tidak ada pesan di saluran.');
      return { ok: true, count: 0, promos: [] };
    }

    channelMsgs.sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));

    let validCount = 0;
    const foundPromos = [];

    for (const cMsg of channelMsgs) {
      const msgId = cMsg.key?.id;
      const msgObj = cMsg.message || {};
      const imgObj = msgObj.imageMessage || 
                     msgObj.viewOnceMessageV2?.message?.imageMessage ||
                     msgObj.viewOnceMessage?.message?.imageMessage ||
                     msgObj.documentWithCaptionMessage?.message?.imageMessage ||
                     (msgObj.documentMessage?.mimetype?.startsWith('image/') ? msgObj.documentMessage : null);

      if (!imgObj) continue;

      const captionHint = imgObj?.caption || msgObj.extendedTextMessage?.text || msgObj.conversation || '';

      try {
        const rawBuffer = await downloadMediaMessage(cMsg, 'buffer', {});
        if (!rawBuffer || rawBuffer.length < 1000) continue;

        const compressedBuffer = await compressImageBuffer(rawBuffer);
        const base64Data = compressedBuffer.toString('base64');
        const promoData = await analyzeImageWithAiVision(base64Data, captionHint);

        if (promoData && promoData.badge && promoData.origin && promoData.destination && promoData.price) {
          validCount++;
          console.log(`🎯 [SALURAN RESMI PROMO ${validCount}/6]: ${promoData.badge} ${promoData.origin}->${promoData.destination} Rp ${promoData.price}`);
          await commitPromosToGitHub(promoData);
          await uploadPosterToGitHub(base64Data, promoData, compressedBuffer);
          foundPromos.push({
            id: msgId,
            badge: promoData.badge,
            route: `${promoData.origin} - ${promoData.destination}`,
            price: promoData.price,
            date: promoData.date
          });
          if (validCount >= 6) {
            logSync(`✅ Sukses update 6 promo resmi terbaru dari saluran!`);
            break;
          }
        } else {
          console.log(`⛔ [NON-PROMO DIABAIKAN] ID: ${msgId}`);
        }
      } catch (err) {
        console.error(`Error analyzing msg ${msgId}:`, err.message);
      }
    }

    try {
      fs.writeFileSync('/home/container/latest_6_promos_result.json', JSON.stringify({
        timestamp: new Date().toISOString(),
        count: validCount,
        promos: foundPromos
      }, null, 2), 'utf-8');
    } catch (e) {}

    return { ok: true, count: validCount, promos: foundPromos };
  } catch (err) {
    logSync(`Error sync saluran: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

const handleSyncRequest = async (req, res) => {
  if (!globalSock || !isConnected) {
    return res.status(503).json({ success: false, message: 'WhatsApp bot belum terkoneksi ke Cloud.' });
  }

  try {
    const result = await syncLatestChannelPromos(40);
    res.json({ success: result.ok, message: `Sinkronisasi selesai! ${result.count} promo resmi terbaru diproses.`, promos: result.promos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/sync', handleSyncRequest);
app.post('/wa/promo/api/sync', handleSyncRequest);
app.get('/api/sync-6', handleSyncRequest);
app.post('/api/sync-6', handleSyncRequest);

app.listen(PORT, () => {
  console.log(`🌐 Web monitoring active on port ${PORT}`);
});

startWhatsAppBot();

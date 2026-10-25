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

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  sharp = null;
}

// Global process exception handlers
process.on('uncaughtException', (err) => {
  console.error('⚠️ [UNCAUGHT EXCEPTION]:', err?.message || err);
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

const N8N_PROMO_WEBHOOK = process.env.N8N_PROMO_WEBHOOK || 'http://38.49.215.28:3014/webhook/raksa-promo';
function tapToN8nPromo(data) {
  try {
    fetch(N8N_PROMO_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(3000)
    }).catch(() => {});
  } catch {}
}

let latestQrDataUrl = '';
let latestQrRaw = '';
let authStatus = 'Menunggu Inisialisasi WhatsApp Cloud...';
let isConnected = false;
let syncLogHistory = [];
let watchdogInterval = null;
let metadataRetryInterval = null;
let isProcessingQueue = false;
let globalSock = null;

// Persistent processed messages tracking
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

function saveProcessedMessageId(id) {
  if (!id) return;
  processedMessageIds.add(id);
  try {
    const arr = Array.from(processedMessageIds);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    fs.writeFileSync(PROCESSED_DB_FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (e) {}
}

function logSync(msg) {
  const timeStr = new Date().toLocaleTimeString('id-ID');
  console.log(`[${timeStr}] ${msg}`);
  syncLogHistory.unshift(`[${timeStr}] ${msg}`);
  if (syncLogHistory.length > 50) syncLogHistory.pop();
}

console.log('====================================================');
console.log('🤖 RAKSA TRAVEL - 24/7 AUTO CLOUD BAILEYS BOT');
console.log(' Channel Target: ', TARGET_CHANNEL_CODE);
console.log(' GitHub Target:  ', GITHUB_REPO);
console.log('====================================================\n');

// 1. IATA Airport Reference Map
const IATA_MAP = {
  'jayapura': 'DJJ',
  'sentani': 'DJJ',
  'makassar': 'UPG',
  'ujung pandang': 'UPG',
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
  'wamena': 'WMX'
};

function resolveIataCode(cityName, defaultCode = 'DJJ') {
  if (!cityName) return defaultCode;
  const clean = cityName.toLowerCase().trim();
  for (const [key, code] of Object.entries(IATA_MAP)) {
    if (clean.includes(key)) return code;
  }
  return defaultCode;
}

const CITY_LIST = [
  'MAKASSAR', 'JAYAPURA', 'SURABAYA', 'JAKARTA', 'TIMIKA', 'MERAUKE', 'SORONG',
  'BIAK', 'MANOKWARI', 'WAMENA', 'NABIRE', 'DENPASAR', 'BALI', 'YOGYAKARTA',
  'JOGJA', 'SEMARANG', 'BALIKPAPAN', 'BANJARMASIN', 'PONTIANAK', 'MEDAN',
  'PADANG', 'PALEMBANG', 'PEKANBARU', 'BATAM', 'KENDARI', 'GORONTALO',
  'PALU', 'AMBON', 'TERNATE', 'KUPANG', 'LABUAN BAJO'
];

function detectRouteFromText(textUp) {
  const found = [];
  for (const c of CITY_LIST) {
    const idx = textUp.indexOf(c);
    if (idx !== -1) {
      const cap = c.charAt(0) + c.slice(1).toLowerCase();
      found.push({ idx, name: cap });
    }
  }
  found.sort((a, b) => a.idx - b.idx);
  if (found.length >= 2) return [found[0].name, found[1].name];
  if (found.length === 1) return found[0].name === 'Jayapura' ? ['Makassar', 'Jayapura'] : [found[0].name, 'Jayapura'];
  return ['Makassar', 'Jayapura'];
}

// 2. High-Accuracy Fallback Regex Parser for Raksa Travel Story Cards
function parseMultiPromoText(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const clean = raw.replace(/\r/g, '').trim();
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const fullTextUpper = clean.toUpperCase();

  // Validasi format: Wajib ada indikasi promo tiket / Raksa Travel
  const hasPromoKeywords = fullTextUpper.includes('LANGSUNG') || 
                           fullTextUpper.includes('TRANSIT') || 
                           fullTextUpper.includes('BAGASI') || 
                           fullTextUpper.includes('082153043601') || 
                           fullTextUpper.includes('RAKSA') ||
                           fullTextUpper.includes('TGL');
  if (!hasPromoKeywords) return [];

  // 1. Detect Default Header Airline & Transit Mode
  let defaultBadge = '';
  let defaultTransit = 'Penerbangan Langsung';
  let defaultBadgeType = 'airline';

  if (fullTextUpper.includes('CITILINK')) defaultBadge = 'CITILINK';
  else if (fullTextUpper.includes('BATIK')) defaultBadge = 'BATIK AIR';
  else if (fullTextUpper.includes('LION')) defaultBadge = 'LION AIR';
  else if (fullTextUpper.includes('SRIWIJAYA')) defaultBadge = 'SRIWIJAYA AIR';
  else if (fullTextUpper.includes('GARUDA')) defaultBadge = 'GARUDA INDONESIA';
  else if (fullTextUpper.includes('SUPER AIR JET') || fullTextUpper.includes('SUPER AIR')) defaultBadge = 'SUPER AIR JET';
  else if (fullTextUpper.includes('WINGS')) defaultBadge = 'WINGS AIR';
  else if (fullTextUpper.includes('PELNI') || fullTextUpper.includes('KAPAL')) {
    defaultBadge = 'PELNI';
    defaultBadgeType = 'ship';
    defaultTransit = 'Pelayaran Laut';
  }

  if (fullTextUpper.includes('TRANSIT')) defaultTransit = 'Penerbangan Transit';
  else if (fullTextUpper.includes('LANGSUNG')) defaultTransit = 'Penerbangan Langsung';

  // 2. Extract Route (Origin & Destination)
  const [origin, dest] = detectRouteFromText(fullTextUpper);
  if (!origin || !dest) return [];

  // 3. Extract Date
  let date = 'Keberangkatan Terdekat';
  const dateMatch = clean.match(/(?:TGL\s*)?([0-9]{1,2}(?:\s*[-–,\s]\s*[0-9]{1,2})*\s*(?:JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER))/i) ||
                    clean.match(/TGL\s*([0-9\s,\-–sampai]+(?:\s+[A-Za-z]+)?)/i);
  if (dateMatch) {
    const rawDate = dateMatch[1].trim().replace(/^tgl\s*/i, '');
    date = 'Tgl ' + rawDate;
  }

  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const priceMatch = line.match(/(?:RP\.?\s*)?(\d{1,3}(?:[.,]\d{3})+)/i);
    if (priceMatch) {
      const numVal = parseInt(priceMatch[1].replace(/[.,]/g, ''), 10);
      if (numVal < 300000) continue; // Skip sanity check

      let cleanPrice = priceMatch[1].replace(/,/g, '.');
      let badge = defaultBadge;
      let transit = defaultTransit;
      let badgeType = defaultBadgeType;

      const lineUp = line.toUpperCase();
      if (lineUp.includes('BATIK')) badge = 'BATIK AIR';
      else if (lineUp.includes('LION')) badge = 'LION AIR';
      else if (lineUp.includes('SRIWIJAYA')) badge = 'SRIWIJAYA AIR';
      else if (lineUp.includes('CITILINK')) badge = 'CITILINK';
      else if (lineUp.includes('GARUDA')) badge = 'GARUDA INDONESIA';
      else if (lineUp.includes('SUPER') && lineUp.includes('AIR')) badge = 'SUPER AIR JET';
      else if (lineUp.includes('PELNI') || lineUp.includes('KAPAL')) {
        badge = 'PELNI'; badgeType = 'ship'; transit = 'Pelayaran Laut';
      }

      if (!badge) continue;

      if (lineUp.includes('TRANSIT')) transit = 'Penerbangan Transit';
      else if (lineUp.includes('LANGSUNG')) transit = 'Penerbangan Langsung';

      // Baggage check on this line, next line, or previous line
      let baggage = badgeType === 'ship' ? 'Termasuk Bagasi Kapal' : 'Termasuk Bagasi 10 KG';
      if (badge === 'BATIK AIR') baggage = 'Termasuk Bagasi 20 KG';
      else if (badge === 'CITILINK') baggage = 'Termasuk Bagasi 20 KG';

      const combinedBaggageText = (line + ' ' + (lines[i + 1] || '') + ' ' + (lines[i - 1] || '')).toUpperCase();
      const bagMatch = combinedBaggageText.match(/BAGASI\s*(\d+)(?:\s*KG)?/i);
      if (bagMatch) {
        baggage = 'Termasuk Bagasi ' + bagMatch[1] + ' KG';
      }

      // Check specific date on line if present
      let itemDate = date;
      const specificDateMatch = line.match(/Tgl\s*([0-9\s,\-–sampai]+(?:\s+[A-Za-z]+)?)/i);
      if (specificDateMatch) {
        itemDate = 'Tgl ' + specificDateMatch[1].trim().replace(/^tgl\s*/i, '');
      }

      items.push({
        badge,
        badgeType,
        airlineLogo: badgeType === 'ship' ? 'ship' : 'plane',
        title: `${badge} ${origin} - ${dest}`,
        desc: `Rp ${cleanPrice} • ${itemDate} • ${transit} • ${baggage}`,
        price: cleanPrice,
        date: itemDate,
        transit,
        baggage,
        origin,
        originCode: resolveIataCode(origin, 'UPG'),
        destination: dest,
        destinationCode: resolveIataCode(dest, 'DJJ'),
        waText: encodeURIComponent(`Halo RaksaTravel, saya mau ambil tiket promo ${badge} ${origin} - ${dest} Rp ${cleanPrice} (${itemDate})`)
      });
    }
  }

  return items;
}

// 3. Multi-Model Cascade AI Vision Parser (Gemini 3.7 / 3.8 / Fallbacks)
async function analyzeImageWithAiVision(base64Data, captionHint = '') {
  const prompt = `Anda adalah AI Vision & OCR Engine spesialis membaca kartu poster promo resmi Raksa Travel.

FORMAT RESMI POSTER PROMO RAKSA TRAVEL YANG WAJIB DISETUJUI:
Poster bertipe WhatsApp Story / Status Card dengan latar belakang solid atau gradasi warna (contoh: pink/magenta, ungu, navy/biru dongker, hijau) dengan tipografi teks tebal di tengah.

CONTOH FORMAT 1 (Multi Opsi / Baris):
CITILINK LANGSUNG
MAKASSAR JAYAPURA
TGL 29 OKTOBER
➡️3,040,000 Bagasi 15
➡️3,100,000 Bagasi 20
Wa082153043601

CONTOH FORMAT 2 (Single Opsi):
BATIK LANGSUNG
MAKASSAR JAYAPURA
3,090,000
TGL 27 OKTOBER
BAGASI 20 KG
WA082153043601

CONTOH FORMAT 3 (Multi Maskapai):
MAKASSAR JAYAPURA TGL 29 OKTOBER
➡️Lion Langsung 2,910,000 Bagasi 10
➡️Batik Langsung 3,090,000 Bagasi 20
Wa082153043601

SYARAT VALIDASI MUTLAK:
1. Gambar WAJIB merupakan kartu poster promo tiket pesawat / kapal resmi Raksa Travel dengan komponen:
   - Nama Maskapai / Kapal (Citilink, Batik Air, Lion Air, Sriwijaya Air, Garuda Indonesia, Super Air Jet, Pelni, Wings Air)
   - Rute Kota Asal & Tujuan (contoh: Makassar Jayapura)
   - Tanggal keberangkatan (contoh: Tgl 29 Oktober, Tgl 27 Oktober)
   - Nominal harga tiket (angka ribuan, contoh: 3,040,000 atau 3,090,000)
   - Informasi bagasi (contoh: Bagasi 15, Bagasi 20 KG)
2. JIKA GAMBAR BUKAN kartu poster promo tiket Raksa Travel (misalnya: foto manusia/selfie, struk transfer bank/bukti bayar, meme, pemandangan, screenshot chat biasa, brosur produk lain), ANDA WAJIB MENOLAKNYA dengan mengembalikan JSON persis:
{"is_valid": false}

3. JIKA VALID, ekstrak seluruh opsi tiket promo yang tertera ke dalam format JSON persis:
{
  "is_valid": true,
  "origin": "Nama kota asal keberangkatan (contoh: Makassar)",
  "originCode": "Kode 3 huruf IATA asal (contoh: UPG)",
  "destination": "Nama kota tujuan (contoh: Jayapura)",
  "destinationCode": "Kode 3 huruf IATA tujuan (contoh: DJJ)",
  "date": "Tanggal atau periode keberangkatan (contoh: Tgl 29 Oktober)",
  "promos": [
    {
      "badge": "LION AIR / BATIK AIR / CITILINK / SRIWIJAYA AIR / GARUDA INDONESIA / SUPER AIR JET / PELNI / WINGS AIR",
      "badgeType": "airline atau ship",
      "transit": "Penerbangan Langsung / Penerbangan Transit / Pelayaran Laut",
      "price": "Nominal angka harga dengan titik ribuan (contoh: 3.040.000)",
      "date": "Tanggal keberangkatan opsi ini (contoh: Tgl 29 Oktober)",
      "baggage": "Keterangan bagasi (contoh: Termasuk Bagasi 15 KG / Termasuk Bagasi 20 KG)"
    }
  ]
}

PANDUAN KETAT:
- Pastikan Origin (Kota Asal) dan Destination (Kota Tujuan) TIDAK tertukar.
- Ekstrak SEMUA opsi harga yang ada di kartu promo (jangan hanya satu jika tertera lebih dari 1 baris).
- HANYA KEMBALIKAN JSON VALID MURNI TANPA MARKDOWN ATAU PENJELASAN LAIN.`;

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
                { type: 'text', text: prompt + (captionHint ? `\nPetunjuk Teks Caption: "${captionHint}"` : '') },
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
        if (data.is_valid !== true || !data.origin || !data.destination) {
          continue;
        }

        const origin = data.origin;
        const dest = data.destination;
        const originCode = data.originCode || resolveIataCode(origin, 'UPG');
        const destCode = data.destinationCode || resolveIataCode(dest, 'DJJ');
        const defaultDate = data.date || 'Keberangkatan Terdekat';

        let rawPromos = [];
        if (Array.isArray(data.promos) && data.promos.length > 0) {
          rawPromos = data.promos;
        } else if (data.price) {
          rawPromos = [{
            badge: data.badge,
            badgeType: data.badgeType,
            transit: data.transit,
            price: data.price,
            date: data.date,
            baggage: data.baggage
          }];
        }

        const validPromos = [];
        for (const p of rawPromos) {
          if (!p.price) continue;
          let cleanPrice = String(p.price).replace(/Rp\.?\s*/i, '').replace(/,/g, '.').replace(/[^\d.]/g, '').trim();
          if (/^\d{6,8}$/.test(cleanPrice)) {
            cleanPrice = Number(cleanPrice).toLocaleString('id-ID');
          }
          const numPrice = parseInt(cleanPrice.replace(/\./g, ''), 10);
          if (isNaN(numPrice) || numPrice < 300000) continue;

          let badgeName = (p.badge || 'LION AIR').toUpperCase();
          if (badgeName.includes('BATIK')) badgeName = 'BATIK AIR';
          else if (badgeName.includes('LION')) badgeName = 'LION AIR';
          else if (badgeName.includes('SRIWIJAYA')) badgeName = 'SRIWIJAYA AIR';
          else if (badgeName.includes('GARUDA')) badgeName = 'GARUDA INDONESIA';
          else if (badgeName.includes('CITILINK')) badgeName = 'CITILINK';
          else if (badgeName.includes('SUPER') && badgeName.includes('AIR')) badgeName = 'SUPER AIR JET';
          else if (badgeName.includes('PELNI') || badgeName.includes('KAPAL')) badgeName = 'PELNI';

          let transitType = p.transit || (badgeName === 'PELNI' ? 'Pelayaran Laut' : 'Penerbangan Langsung');
          if (String(p.badge).toUpperCase().includes('TRANSIT')) transitType = 'Penerbangan Transit';

          const itemDate = p.date || defaultDate;
          let baggageText = p.baggage || (badgeName === 'PELNI' ? 'Termasuk Bagasi Kapal' : (badgeName === 'BATIK AIR' ? 'Termasuk Bagasi 20 KG' : 'Termasuk Bagasi 10 KG'));

          validPromos.push({
            badge: badgeName,
            badgeType: badgeName === 'PELNI' ? 'ship' : 'airline',
            airlineLogo: badgeName === 'PELNI' ? 'ship' : 'plane',
            origin,
            originCode,
            destination: dest,
            destinationCode: destCode,
            title: `${badgeName} ${origin} - ${dest}`,
            desc: `Rp ${cleanPrice} • ${itemDate} • ${transitType} • ${baggageText}`,
            transit: transitType,
            price: cleanPrice,
            date: itemDate,
            baggage: baggageText,
            waText: encodeURIComponent(`Halo RaksaTravel, saya mau ambil tiket promo ${badgeName} ${origin} - ${dest} Rp ${cleanPrice} (${itemDate})`)
          });
        }

        if (validPromos.length > 0) {
          console.log(`✨ [AI VISION SUKSES via ${modelName}]: ${validPromos.length} Promo tervalidasi (${validPromos.map(x => `${x.badge} Rp ${x.price}`).join(', ')})`);
          return validPromos;
        }
      }
    } catch (err) {
      console.log(`AI Vision error on ${modelName}:`, err.message);
    }
  }

  // Regex fallback if AI unavailable
  if (captionHint) {
    const fallbackList = parseMultiPromoText(captionHint);
    if (fallbackList.length > 0) {
      console.log(`⚡ [FALLBACK REGEX SUKSES]: ${fallbackList.length} Promo diekstrak dari caption`);
      return fallbackList;
    }
  }

  return [];
}

// 4. MozJPEG Progressive Image Compression via Sharp
async function compressImageBuffer(inputBuffer) {
  if (!sharp) return inputBuffer;
  try {
    return await sharp(inputBuffer)
      .resize({
        width: 1080,
        height: 1920,
        fit: 'inside',
        withoutEnlargement: true
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

// 5. GitHub API Helper Functions
const ghHeaders = () => ({
  'User-Agent': 'Raksa-Baileys-Cloud-Bot',
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github.v3+json'
});

async function uploadImageToGitHub(fileName, base64ImageData, promo) {
  if (!GITHUB_TOKEN) return false;
  const imgUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${fileName}`;
  const res = await fetch(imgUrl, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `auto: upload poster promo [${promo.badge} ${promo.origin}-${promo.destination}]`,
      content: base64ImageData
    })
  });
  if (!res.ok) {
    console.error(`❌ [GITHUB ERROR upload image]: HTTP ${res.status}`);
    return false;
  }
  return true;
}

// Sync all promos to promo-posters.json and promos.json atomically
async function syncAllPromosToGitHub(fileName, promoList) {
  if (!GITHUB_TOKEN || !promoList || promoList.length === 0) return false;
  const timestamp = Date.now();

  // A. Update promo-posters.json
  const postersUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/promo-posters.json`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let posters = [];
      let sha = '';
      const getRes = await fetch(postersUrl, { headers: ghHeaders() });
      if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha || '';
        posters = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));
      }

      for (let i = promoList.length - 1; i >= 0; i--) {
        const promo = promoList[i];
        const newPoster = {
          id: `poster-${timestamp}-${i}`,
          image: fileName,
          badge: promo.badge,
          badgeType: promo.badgeType,
          title: promo.title,
          desc: promo.desc,
          price: promo.price,
          date: promo.date,
          waText: promo.waText,
          addedAt: new Date().toISOString()
        };

        const dupIdx = posters.findIndex(p => p.title === newPoster.title && p.price === newPoster.price && p.date === newPoster.date);
        if (dupIdx !== -1) {
          posters.splice(dupIdx, 1);
        }
        posters.unshift(newPoster);
      }

      posters = posters.slice(0, 6);

      const putRes = await fetch(postersUrl, {
        method: 'PUT',
        headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `auto: live poster update (${promoList.map(p => p.badge).join(', ')}) from WhatsApp Channel`,
          content: Buffer.from(JSON.stringify(posters, null, 2)).toString('base64'),
          sha: sha || undefined
        })
      });

      if (putRes.ok) {
        console.log(`🎉 [GITHUB PUSH] Sukses deploy promo-posters.json ke website!`);
        break;
      }
    } catch (err) {
      console.error(`Posters commit attempt ${attempt} error:`, err.message);
    }
  }

  // B. Update promos.json
  const promosUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/promos.json`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let currentPromos = [];
      let sha = '';
      const getRes = await fetch(promosUrl, { headers: ghHeaders() });
      if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha || '';
        currentPromos = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));
      }

      for (let i = promoList.length - 1; i >= 0; i--) {
        const promo = promoList[i];
        const newPromoItem = {
          id: `promo-${timestamp}-${i}`,
          badge: promo.badge,
          badgeType: promo.badgeType,
          airlineLogo: promo.airlineLogo,
          origin: promo.origin,
          originCode: promo.originCode,
          destination: promo.destination,
          destinationCode: promo.destinationCode,
          transit: promo.transit,
          price: promo.price,
          date: promo.date,
          baggage: promo.baggage,
          waText: promo.waText
        };

        const dupIdx = currentPromos.findIndex(p => p.badge === newPromoItem.badge && p.origin === newPromoItem.origin && p.destination === newPromoItem.destination && p.price === newPromoItem.price);
        if (dupIdx !== -1) {
          currentPromos.splice(dupIdx, 1);
        }
        currentPromos.unshift(newPromoItem);
      }

      currentPromos = currentPromos.slice(0, 6);

      const putRes = await fetch(promosUrl, {
        method: 'PUT',
        headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `auto: live promos.json update (${promoList.map(p => p.badge).join(', ')}) from WhatsApp Channel`,
          content: Buffer.from(JSON.stringify(currentPromos, null, 2)).toString('base64'),
          sha: sha || undefined
        })
      });

      if (putRes.ok) {
        console.log(`🎉 [GITHUB PUSH] Sukses deploy promos.json ke website!`);
        break;
      }
    } catch (err) {
      console.error(`Promos commit attempt ${attempt} error:`, err.message);
    }
  }

  // Also sync locally if website workspace is present
  try {
    const localDir = path.join(__dirname, '..');
    const localPostersFile = path.join(localDir, 'promo-posters.json');
    const localPromosFile = path.join(localDir, 'promos.json');
    if (fs.existsSync(localPostersFile)) {
      let localPosters = JSON.parse(fs.readFileSync(localPostersFile, 'utf-8'));
      for (const p of promoList) {
        localPosters.unshift({
          id: `poster-${timestamp}`,
          image: fileName,
          badge: p.badge,
          badgeType: p.badgeType,
          title: p.title,
          desc: p.desc,
          price: p.price,
          date: p.date,
          waText: p.waText,
          addedAt: new Date().toISOString()
        });
      }
      fs.writeFileSync(localPostersFile, JSON.stringify(localPosters.slice(0, 6), null, 2), 'utf-8');
    }

    // Sync ke D:\RAKSA TRAVEL V3\promos.json (V3 clean format, tepat 6 item FIFO)
    const v3PromosPath = 'D:\\RAKSA TRAVEL V3\\promos.json';
    if (fs.existsSync(v3PromosPath)) {
      let v3List = [];
      try { v3List = JSON.parse(fs.readFileSync(v3PromosPath, 'utf-8')); } catch (e) {}
      if (!Array.isArray(v3List)) v3List = [];

      const mNames = {januari:1,jan:1,februari:2,feb:2,maret:3,mar:3,april:4,apr:4,mei:5,may:5,juni:6,jun:6,juli:7,jul:7,agustus:8,agu:8,aug:8,september:9,sep:9,oktober:10,okt:10,oct:10,november:11,nov:11,desember:12,des:12,dec:12};
      for (const p of promoList) {
        const rawPrice = parseInt(String(p.price || 0).replace(/\D/g, ''), 10) || 0;
        const bagMatch = String(p.baggage || '').match(/\d+/);
        const rawBaggage = bagMatch ? parseInt(bagMatch[0], 10) : 20;
        const isDirect = !String(p.transit || '').toLowerCase().includes('transit') ? 1 : 0;
        const dMatch = String(p.date || '').match(/\b\d{1,2}\b/g);
        const days = dMatch ? [...new Set(dMatch.map(Number).filter(n => n >= 1 && n <= 31))] : [new Date().getDate()];
        let month = new Date().getMonth() + 1;
        const dLower = String(p.date || '').toLowerCase();
        for (const [k, v] of Object.entries(mNames)) { if (dLower.includes(k)) { month = v; break; } }

        const item = {
          a: p.badge || 'Lion Air',
          d: isDirect,
          f: p.origin || 'Jayapura',
          t: p.destination || 'Makassar',
          days: days.length ? days : [new Date().getDate()],
          m: month,
          tiers: [{ p: rawPrice, b: rawBaggage }]
        };

        // Hapus duplikat rute & maskapai lama (deduplikasi)
        v3List = v3List.filter(x => !(x.a === item.a && x.f === item.f && x.t === item.t && x.m === item.m));
        // Taruh promo terbaru di paling depan (FIFO)
        v3List.unshift(item);
      }

      // Pertahankan tepat 6 promo aktif terbaru (yang terlama otomatis keluar dari queue)
      v3List = v3List.slice(0, 6);
      fs.writeFileSync(v3PromosPath, JSON.stringify(v3List, null, 2), 'utf-8');
      console.log(`✅ [PROMO V3 LOCAL]: Sukses update D:\\RAKSA TRAVEL V3\\promos.json (${v3List.length} items FIFO)`);
    }
  } catch (e) {}

  return true;
}

// 6. Process Inbound WhatsApp Media Message
async function processMessageMedia(msg, sourceTag = 'EVENT') {
  const msgId = msg.key?.id;
  if (msgId && processedMessageIds.has(msgId)) {
    return null;
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
    console.log(`\n📥 [${sourceTag}] Poster Saluran Terdeteksi (ID: ${msgId})`);
    try {
      const rawBuffer = await downloadMediaMessage(msg, 'buffer', {});
      if (rawBuffer && rawBuffer.length > 1000) {
        console.log(`📦 Mengompres poster (Ukuran asli: ${(rawBuffer.length / 1024).toFixed(1)} KB)...`);
        const compressedBuffer = await compressImageBuffer(rawBuffer);
        console.log(`✨ Hasil kompresi: ${(compressedBuffer.length / 1024).toFixed(1)} KB`);

        const base64Data = compressedBuffer.toString('base64');
        console.log('🤖 Ekstraksi metadata promo dengan AI Vision / OCR Engine...');
        const promoList = await analyzeImageWithAiVision(base64Data, captionHint);

        if (!promoList || promoList.length === 0) {
          console.log(`⛔ [DIABAIKAN] Gambar ID ${msgId} BUKAN poster promo tiket resmi Raksa Travel. Ditolak.`);
          return null;
        }

        console.log(`✅ [PROMO TERVALIDASI]: ${promoList.length} opsi promo ditemukan.`);
        const timestamp = Date.now();
        const fileName = `images/promo-${timestamp}.jpeg`;

        // 1. Upload compressed image to GitHub
        await uploadImageToGitHub(fileName, base64Data, promoList[0]);

        // 2. Commit all promo entries to promo-posters.json and promos.json
        await syncAllPromosToGitHub(fileName, promoList);

        for (const p of promoList) {
          logSync(`Deploy Promo: ${p.badge} ${p.origin} -> ${p.destination} (Rp ${p.price})`);
          tapToN8nPromo({
            event: 'promo_synced',
            rute: `${p.origin} -> ${p.destination}`,
            harga: p.price,
            maskapai: p.badge
          });
        }

        if (msgId) {
          saveProcessedMessageId(msgId);
        }
        return promoList;
      }
    } catch (err) {
      console.error(`❌ Gagal mendownload / memproses gambar: ${err.message}`);
    }
  }
  return null;
}

// 7. Polling Watchdog for Newsletter (Guarantees 100% detection)
function startNewsletterWatchdog(sock) {
  if (watchdogInterval) clearInterval(watchdogInterval);

  const fetchChannelUpdates = async () => {
    if (!isConnected || typeof sock.newsletterFetchMessages !== 'function') return;
    if (isProcessingQueue) return;

    isProcessingQueue = true;
    try {
      const channelMsgs = await sock.newsletterFetchMessages(TARGET_CHANNEL_JID, 25);
      if (channelMsgs && channelMsgs.length > 0) {
        channelMsgs.sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
        for (const cMsg of channelMsgs) {
          const msgId = cMsg.key?.id;
          if (msgId && !processedMessageIds.has(msgId)) {
            await processMessageMedia(cMsg, 'WATCHDOG-POLL');
          }
        }
      }
    } catch (err) {
      // Silent catch
    } finally {
      isProcessingQueue = false;
    }
  };

  fetchChannelUpdates();
  watchdogInterval = setInterval(fetchChannelUpdates, 15000);
}

// 8. Connect Baileys WhatsApp Engine
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
        console.log('Sesi logout. Menghapus sesi lama...');
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch (e) {}
        setTimeout(startWhatsAppBot, 3000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      latestQrDataUrl = '';
      latestQrRaw = '';
      authStatus = 'Terhubung ke WhatsApp Cloud! 🚀';
      console.log('✅ [WHATSAPP CLOUD TERHUBUNG!]: Bot aktif memantau saluran 24/7');
      logSync('🚀 WhatsApp Cloud Terhubung!');

      startNewsletterWatchdog(sock);

      if (typeof sock.newsletterMetadata === 'function') {
        const queryMetadata = async () => {
          try {
            const meta = await sock.newsletterMetadata('invite', TARGET_CHANNEL_CODE);
            if (meta?.id) {
              TARGET_CHANNEL_JID = meta.id;
              console.log(`📡 [SALURAN TERDAFTAR]: ${meta.name || 'Raksa Travel'} (JID: ${TARGET_CHANNEL_JID})`);
              logSync(`Saluran Terdeteksi: ${meta.name || 'Raksa Travel'}`);

              if (typeof sock.newsletterFollow === 'function') {
                await sock.newsletterFollow(TARGET_CHANNEL_JID).catch(() => {});
              }
              if (typeof sock.subscribeNewsletterUpdates === 'function') {
                await sock.subscribeNewsletterUpdates(TARGET_CHANNEL_JID).catch(() => {});
                console.log(`📡 [LIVE FEED TERHUBUNG]: Subscribed saluran WhatsApp 100%`);
                logSync('Live Feed Saluran Aktif!');
              }
            }
          } catch (e) {
            console.log('Notice: Info metadata saluran ditunda.');
          }
        };
        queryMetadata();
        metadataRetryInterval = setInterval(queryMetadata, 60000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        const remoteJid = msg.key?.remoteJid || '';

        // STRICT FILTER: HANYA proses & push promo yang di-upload di Saluran WhatsApp "RAKSA TRAVEL"
        const isFromTargetChannel = (remoteJid === TARGET_CHANNEL_JID) ||
                                   (remoteJid === '120363413097453454@newsletter');

        if (!isFromTargetChannel) {
          // Abaikan semua pesan di luar channel resmi RAKSA TRAVEL (private chat, grup lain, dll)
          continue;
        }

        await processMessageMedia(msg, 'LIVE-CHANNEL');
      } catch (err) {
        console.log('Error processing incoming message:', err.message);
      }
    }
  });
}

// 9. Express Web Server for Monitoring & Manual Sync
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
        .card { background: #0f1a2e; border: 2px solid #25D366; padding: 30px; border-radius: 20px; box-shadow: 0 10px 40px rgba(37, 211, 102, 0.2); max-width: 480px; width: 92%; }
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
          <p>Scan QR Code berikut menggunakan WhatsApp Anda:</p>
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
            let res = await fetch('/api/sync', { method: 'POST' }).catch(() => null);
            if (!res || !res.ok) {
              res = await fetch('/wa/promo/api/sync', { method: 'POST' });
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
    connected: isConnected,
    status: authStatus,
    targetChannel: TARGET_CHANNEL_JID,
    processedCount: processedMessageIds.size,
    recentLogs: syncLogHistory.slice(0, 10)
  });
});

app.post(['/api/sync', '/wa/promo/api/sync'], async (req, res) => {
  if (!isConnected || !globalSock) {
    return res.status(503).json({ error: 'WhatsApp bot belum terhubung.' });
  }

  try {
    if (typeof globalSock.newsletterFetchMessages === 'function') {
      const channelMsgs = await globalSock.newsletterFetchMessages(TARGET_CHANNEL_JID, 15);
      let count = 0;
      if (channelMsgs && channelMsgs.length > 0) {
        for (const msg of channelMsgs) {
          const msgId = msg.key?.id;
          if (msgId && !processedMessageIds.has(msgId)) {
            const p = await processMessageMedia(msg, 'MANUAL-TRIGGER');
            if (p) count++;
          }
        }
      }
      return res.json({ success: true, message: `Sinkronisasi selesai. Diproses: ${count} promo baru.` });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ success: true, message: 'Pemeriksaan selesai.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 [WEB DASHBOARD] Aktif pada port ${PORT}`);
  startWhatsAppBot();
});

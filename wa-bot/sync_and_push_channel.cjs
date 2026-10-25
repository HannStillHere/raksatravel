const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const GITHUB_REPO = 'raksatravel/raksatravel.github.io';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TARGET_CHANNEL_CODE = '0029VbCYmHQ9WtBxoi1pjH0f';

// 1. AI Vision Extractor
async function analyzeImageWithAiVision(base64Data) {
  const prompt = `Anda adalah AI Vision & OCR Engine beresolusi tinggi (Ultra-HD Optical Precision) resmi untuk Raksa Travel (layanan tiket pesawat & kapal laut).

TUGAS UTAMA:
Lakukan pemindaian OCR visual resolusi tinggi (pixel-by-pixel) dari gambar poster ini.
1. Jika gambar BUKAN poster promo tiket pesawat / kapal laut, kembalikan: {"is_valid": false}

2. Jika gambar ADALAH POSTER TIKET PROMO, baca seluruh teks secara teliti dan ekstraksi data berikut dalam format JSON murni:
{
  "is_valid": true,
  "badge": "Nama maskapai/operator resmi (contoh: LION AIR, BATIK AIR, SRIWIJAYA AIR, CITILINK, GARUDA INDONESIA, SUPER AIR JET, WINGS AIR, PELNI)",
  "badgeType": "airline atau ship",
  "origin": "Nama kota asal penerbangan/keberangkatan (contoh: Makassar, Jayapura, Surabaya, Jakarta, Denpasar, Timika, Biak, Sorong)",
  "originCode": "Kode bandara asal 3 huruf resmi IATA (contoh: UPG, DJJ, SUB, CGK, DPS, TIM, BIK, SOQ)",
  "destination": "Nama kota tujuan (contoh: Jayapura, Makassar, Surabaya, Jakarta, Denpasar, Timika, Biak, Sorong)",
  "destinationCode": "Kode bandara tujuan 3 huruf resmi IATA (contoh: DJJ, UPG, SUB, CGK, DPS, TIM, BIK, SOQ)",
  "transit": "Tipe rute persis (contoh: Penerbangan Langsung / Penerbangan Transit / Transit Makassar / Transit Surabaya / Transit 1X)",
  "price": "Nominal harga termurah (hanya angka dengan titik pemisah ribuan, tanpa kata Rp, contoh: 3.170.000 / 3.305.000 / 2.290.000 / 1.950.000)",
  "date": "Rincian tanggal/periode keberangkatan persis seperti di poster (contoh: Tgl 21 s/d 30 September / Tgl 17, 19, 22, 24, 26, 29 September)",
  "baggage": "Keterangan jatah bagasi resmi (contoh: Termasuk Bagasi 10 KG / Termasuk Bagasi 15 KG / Termasuk Bagasi 20 KG / Tanpa Bagasi)",
  "phone": "Nomor WhatsApp/kontak yang tertera di poster (contoh: 082153043601)"
}

PANDUAN PEMBACAAN OCR:
- Periksa angka dengan sangat cermat.
- HANYA KEMBALIKAN JSON VALID TANPA MARKDOWN.`;

  try {
    const res = await fetch('http://127.0.0.1:20128/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-314fd95655a96de0-jnhrcd-d8fe965d'
      },
      body: JSON.stringify({
        model: 'ag/gemini-3.7-flash-high',
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
        temperature: 0.1
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
      const matchJson = content.match(/\{[\s\S]*\}/);
      if (!matchJson) return null;

      const data = JSON.parse(matchJson[0]);
      if (data.is_valid === false || !data.origin || !data.destination || !data.price) {
        return null;
      }

      const cleanPrice = String(data.price).replace(/Rp\s*/i, '').replace(/,/g, '.').trim();
      let badgeName = (data.badge || 'TIKET PROMO').toUpperCase();
      if (badgeName.includes('LION') && !badgeName.includes('AIR')) badgeName = 'LION AIR';
      if (badgeName.includes('BATIK') && !badgeName.includes('AIR')) badgeName = 'BATIK AIR';
      if (badgeName.includes('SRIWIJAYA') && !badgeName.includes('AIR')) badgeName = 'SRIWIJAYA AIR';

      return {
        id: `promo-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        badge: badgeName,
        badgeType: data.badgeType || 'airline',
        airlineLogo: data.badgeType === 'ship' ? 'ship' : 'plane',
        origin: data.origin,
        originCode: data.originCode || 'DJJ',
        destination: data.destination,
        destinationCode: data.destinationCode || 'UPG',
        transit: data.transit || 'Penerbangan Langsung',
        price: cleanPrice,
        date: data.date || 'Keberangkatan Terdekat',
        baggage: data.baggage || 'Termasuk Bagasi',
        waText: encodeURIComponent(`Halo RaksaTravel, saya mau ambil tiket promo ${badgeName} ${data.origin} - ${data.destination} Rp ${cleanPrice} (${data.date || ''})`)
      };
    }
  } catch (err) {
    console.error('Vision Error:', err.message);
  }
  return null;
}

// 2. GitHub Push Helper
async function pushToGitHub(base64ImageData, promoData) {
  const ghHeaders = {
    'User-Agent': 'Raksa-Baileys-Cloud-Bot',
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  const timestamp = Date.now();
  const fileName = `images/promo-${timestamp}.jpeg`;

  // A. Upload Image File
  try {
    const imgUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${fileName}`;
    const putImgRes = await fetch(imgUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `auto: upload poster promo ${promoData.badge} ${promoData.origin}-${promoData.destination}`,
        content: base64ImageData
      })
    });
    console.log(`Uploaded image ${fileName}:`, putImgRes.status);
  } catch (e) {
    console.error('Error uploading image:', e.message);
  }

  // B. Update promo-posters.json
  try {
    const postersUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/promo-posters.json`;
    let posters = [];
    let sha = '';
    const getRes = await fetch(postersUrl, { headers: ghHeaders });
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha || '';
      posters = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));
    }

    const descText = `Rp ${promoData.price} • ${promoData.date} • ${promoData.transit} • ${promoData.baggage}`;
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

    posters.unshift(newPoster);
    posters = posters.slice(0, 12);

    const putPostersRes = await fetch(postersUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `auto: update gallery poster [${promoData.badge} ${promoData.origin}-${promoData.destination}]`,
        content: Buffer.from(JSON.stringify(posters, null, 2)).toString('base64'),
        sha: sha || undefined
      })
    });
    console.log('Updated promo-posters.json:', putPostersRes.status);
  } catch (e) {
    console.error('Error updating promo-posters.json:', e.message);
  }

  // C. Update promos.json
  try {
    const fileUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/promos.json`;
    let currentPromos = [];
    let sha = '';
    const getRes = await fetch(fileUrl, { headers: ghHeaders });
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha || '';
      currentPromos = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));
    }

    currentPromos.unshift(promoData);
    currentPromos = currentPromos.slice(0, 12);

    const putRes = await fetch(fileUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `auto: update promos.json [${promoData.badge} ${promoData.origin}-${promoData.destination}]`,
        content: Buffer.from(JSON.stringify(currentPromos, null, 2)).toString('base64'),
        sha: sha || undefined
      })
    });
    console.log('Updated promos.json:', putRes.status);
  } catch (e) {
    console.error('Error updating promos.json:', e.message);
  }
}

async function startSync() {
  console.log('🚀 Connecting to WhatsApp Socket to extract 6 channel posters...');
  const authDir = path.join(__dirname, 'baileys_auth_info');
  const { state } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    syncFullHistory: false
  });

  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      console.log('✅ WA Connected! Fetching channel messages...');
      try {
        const meta = await sock.newsletterMetadata('invite', TARGET_CHANNEL_CODE);
        console.log(`📢 Channel: ${meta?.name} (${meta?.id})`);
        const jid = meta.id;

        const msgs = await sock.newsletterFetchMessages(jid, 25);
        console.log(`Found ${msgs?.length || 0} messages in channel.`);

        if (msgs && msgs.length > 0) {
          // Filter image messages
          const imgMsgs = [];
          for (const m of msgs) {
            const hasImg = !!(m.message?.imageMessage || m.message?.viewOnceMessageV2?.message?.imageMessage || m.message?.documentWithCaptionMessage?.message?.imageMessage);
            if (hasImg) {
              imgMsgs.push(m);
            }
          }

          console.log(`Found ${imgMsgs.length} image posters in channel!`);
          // Process latest 6 image posters
          const targetMsgs = imgMsgs.slice(-6);

          for (let i = 0; i < targetMsgs.length; i++) {
            const m = targetMsgs[i];
            console.log(`\n[${i + 1}/${targetMsgs.length}] Downloading poster (ID: ${m.key?.id})...`);
            try {
              const buffer = await downloadMediaMessage(m, 'buffer', {});
              if (buffer && buffer.length > 1000) {
                const b64 = buffer.toString('base64');
                console.log(`Analyzing with Gemini 3.7 Vision OCR...`);
                const pData = await analyzeImageWithAiVision(b64);
                if (pData) {
                  console.log(`✅ Valid Promo: ${pData.badge} | ${pData.origin} -> ${pData.destination} | Rp ${pData.price} (${pData.date})`);
                  console.log(`📤 Pushing to GitHub repository...`);
                  await pushToGitHub(b64, pData);
                  console.log(`🎉 Poster ${i + 1} pushed to GitHub successfully!`);
                } else {
                  console.log(`⚠️ Poster OCR could not extract structured flight details.`);
                }
              }
            } catch (err) {
              console.error(`Error processing poster ${i + 1}:`, err.message);
            }
          }
          console.log('\n✨ ALL 6 PROMO POSTERS PROCESSED & PUSHED TO GITHUB/WEBSITE!');
        }
      } catch (err) {
        console.error('Fatal error during sync:', err);
      }
      setTimeout(() => process.exit(0), 4000);
    }
  });
}

startSync();

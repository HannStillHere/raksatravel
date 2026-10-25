const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const GITHUB_REPO = 'raksatravel/raksatravel.github.io';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TARGET_CHANNEL_CODE = '0029VbCYmHQ9WtBxoi1pjH0f';

async function analyzePosterWithVision(base64Data) {
  const prompt = `Lakukan pemindaian OCR visual resolusi tinggi dari gambar poster tiket promo ini.
Ekstraksi data berikut dalam format JSON murni:
{
  "is_valid": true,
  "badge": "Nama maskapai/operator resmi (contoh: LION AIR, BATIK AIR, SRIWIJAYA AIR, CITILINK, GARUDA INDONESIA, SUPER AIR JET, WINGS AIR, PELNI)",
  "badgeType": "airline atau ship",
  "origin": "Kota asal (contoh: Makassar, Jayapura, Surabaya, Jakarta, Denpasar, Timika, Biak, Sorong)",
  "originCode": "Kode 3 huruf IATA asal (contoh: UPG, DJJ, SUB, CGK, DPS, TIM, BIK, SOQ)",
  "destination": "Kota tujuan (contoh: Jayapura, Makassar, Surabaya, Jakarta, Denpasar, Timika, Biak, Sorong)",
  "destinationCode": "Kode 3 huruf IATA tujuan (contoh: DJJ, UPG, SUB, CGK, DPS, TIM, BIK, SOQ)",
  "transit": "Penerbangan Langsung / Penerbangan Transit / Transit Makassar / Transit Surabaya",
  "price": "Nominal harga termurah (hanya angka dengan titik, contoh: 3.170.000)",
  "date": "Rincian tanggal/periode (contoh: Tgl 21 s/d 30 September / Tgl 17, 19, 22, 24, 26, 29 September)",
  "baggage": "Keterangan bagasi (contoh: Termasuk Bagasi 10 KG / Bagasi 20 KG)"
}
HANYA KEMBALIKAN JSON VALID.`;

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
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const data = JSON.parse(match[0]);

      if (data.origin && data.destination && data.price) {
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
    }
  } catch (e) {
    console.error('OCR Error:', e.message);
  }
  return null;
}

async function uploadToGitHub(fileName, base64Content, commitMsg) {
  const fileUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${fileName}`;
  const ghHeaders = {
    'User-Agent': 'RaksaTravel-Bot',
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  let sha = undefined;
  try {
    const getRes = await fetch(fileUrl, { headers: ghHeaders });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
  } catch {}

  const putRes = await fetch(fileUrl, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: commitMsg,
      content: base64Content,
      sha: sha
    })
  });

  return putRes.status;
}

async function main() {
  const authDir = path.join(__dirname, 'baileys_auth_info');
  const { state } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    syncFullHistory: false
  });

  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'open') {
      console.log('=== [WA OPEN] Fetching Channel... ===');
      try {
        const meta = await sock.newsletterMetadata('invite', TARGET_CHANNEL_CODE);
        const jid = meta.id;
        console.log(`Channel resolved: ${meta.name} (JID: ${jid})`);

        const messages = await sock.newsletterFetchMessages(jid, 30);
        console.log(`Fetched ${messages?.length || 0} total messages from channel.`);

        const imgMsgs = (messages || []).filter(m => {
          const msgObj = m.message || {};
          return !!(msgObj.imageMessage || msgObj.viewOnceMessageV2?.message?.imageMessage || msgObj.documentWithCaptionMessage?.message?.imageMessage);
        });

        console.log(`Found ${imgMsgs.length} image posters.`);
        const last6 = imgMsgs.slice(-6);

        const newPromosList = [];
        const newPostersList = [];

        for (let i = 0; i < last6.length; i++) {
          const m = last6[i];
          const timestamp = Date.now() + i;
          const imgFileName = `images/promo-${timestamp}.jpeg`;

          console.log(`\nProcessing Poster [${i + 1}/${last6.length}] (ID: ${m.key?.id})...`);
          const buf = await downloadMediaMessage(m, 'buffer', {});
          if (!buf || buf.length < 1000) {
            console.log(`Failed to download buffer for poster ${i + 1}`);
            continue;
          }

          const base64Data = buf.toString('base64');
          console.log(`Running OCR Vision on poster ${i + 1}...`);
          const promoData = await analyzePosterWithVision(base64Data);

          if (promoData) {
            console.log(`✅ Extracted: ${promoData.badge} | ${promoData.origin} -> ${promoData.destination} | Rp ${promoData.price}`);
            
            // Upload Image
            const imgStatus = await uploadToGitHub(imgFileName, base64Data, `auto: upload poster ${promoData.badge} ${promoData.origin}-${promoData.destination}`);
            console.log(`Uploaded image ${imgFileName}: HTTP ${imgStatus}`);

            newPromosList.push(promoData);

            newPostersList.push({
              id: `poster-${timestamp}`,
              image: imgFileName,
              badge: promoData.badge,
              badgeType: promoData.badgeType,
              title: `${promoData.badge} ${promoData.origin} - ${promoData.destination}`,
              desc: `Rp ${promoData.price} • ${promoData.date} • ${promoData.transit} • ${promoData.baggage}`,
              price: promoData.price,
              date: promoData.date,
              waText: promoData.waText,
              addedAt: new Date().toISOString()
            });
          } else {
            console.log(`⚠️ Poster ${i + 1} did not match ticket format, creating fallback entry...`);
            const imgStatus = await uploadToGitHub(imgFileName, base64Data, `auto: upload promo poster ${timestamp}`);
            newPostersList.push({
              id: `poster-${timestamp}`,
              image: imgFileName,
              badge: 'TIKET PROMO',
              badgeType: 'airline',
              title: 'Promo Tiket Pesawat & Kapal',
              desc: 'Hubungi CS Raksa Travel untuk harga & rute terbaik.',
              price: '',
              date: 'Periode Terbatas',
              waText: encodeURIComponent('Halo RaksaTravel, saya tertarik dengan poster promo ini.'),
              addedAt: new Date().toISOString()
            });
          }
        }

        if (newPromosList.length > 0) {
          // Fetch existing promos.json
          const ghHeaders = {
            'User-Agent': 'RaksaTravel-Bot',
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json'
          };
          let existingPromos = [];
          try {
            const getP = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/promos.json`, { headers: ghHeaders });
            if (getP.ok) {
              const d = await getP.json();
              existingPromos = JSON.parse(Buffer.from(d.content, 'base64').toString('utf-8'));
            }
          } catch {}

          const combinedPromos = [...newPromosList, ...existingPromos].slice(0, 10);
          const pStatus = await uploadToGitHub('promos.json', Buffer.from(JSON.stringify(combinedPromos, null, 2)).toString('base64'), 'auto: update 6 latest promos from WhatsApp channel');
          console.log(`Updated promos.json: HTTP ${pStatus}`);
        }

        if (newPostersList.length > 0) {
          const ghHeaders = {
            'User-Agent': 'RaksaTravel-Bot',
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json'
          };
          let existingPosters = [];
          try {
            const getP = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/promo-posters.json`, { headers: ghHeaders });
            if (getP.ok) {
              const d = await getP.json();
              existingPosters = JSON.parse(Buffer.from(d.content, 'base64').toString('utf-8'));
            }
          } catch {}

          const combinedPosters = [...newPostersList, ...existingPosters].slice(0, 10);
          const postStatus = await uploadToGitHub('promo-posters.json', Buffer.from(JSON.stringify(combinedPosters, null, 2)).toString('base64'), 'auto: update 6 latest posters from WhatsApp channel');
          console.log(`Updated promo-posters.json: HTTP ${postStatus}`);
        }

        console.log('🎉 [SUCCESS] All 6 posters and json files updated on GitHub & website!');
        fs.writeFileSync('/home/container/wa_bot/sync_result.json', JSON.stringify({ success: true, count: last6.length, promos: newPromosList }, null, 2));

      } catch (err) {
        console.error('Fatal sync error:', err);
      }
      setTimeout(() => process.exit(0), 2000);
    }
  });
}

main();

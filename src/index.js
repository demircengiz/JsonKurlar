export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/haremaltin") return handleHaremAltin(ctx);
    if (url.pathname === "/tcmb") return handleTCMB(ctx);

    return new Response(
      JSON.stringify({ ok: false, routes: ["/haremaltin", "/tcmb"] }),
      { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  },

  // Scheduled event - her saat başı cache'i güncelle
  async scheduled(event, env, ctx) {
    console.log("Scheduled cache refresh started");
    
    // Her iki endpoint için de cache'i güncelle
    await Promise.all([
      refreshCache(ctx, "haremaltin"),
      refreshCache(ctx, "tcmb")
    ]);
  }
};

async function handleHaremAltin(ctx) {
  const TARGET = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/haremaltin");

  // Türkiye saati kontrolü (UTC+3)
  const turkeyHour = (new Date().getUTCHours() + 3) % 24;
  const isNightMode = turkeyHour >= 0 && turkeyHour < 6;

  const cached = await cache.match(cacheKey);
  
  // Gece modu: Cache varsa yaşına bakmadan kullan (sabaha kadar sabit)
  if (isNightMode) {
    if (cached) return cached;
    // Cache yoksa bir kere çek ve sabaha kadar bu veriyi kullan
  }

  // Gündüz modu: Normal cache kontrolü
  if (!isNightMode && cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    if (cachedAt && Date.now() - Number(cachedAt) < 10_000) return cached;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4500);

  try {
    const upstream = await fetch(TARGET, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://canlipiyasalar.haremaltin.com/"
      }
    });

    if (!upstream.ok) {
      if (cached) return cached;
      return jsonErr(502, { ok: false, error: "Upstream failed", status: upstream.status });
    }

    const res = new Response(upstream.body, upstream);
    res.headers.set("Content-Type", "application/json; charset=utf-8");
    res.headers.set("Cache-Control", "public, max-age=5");
    res.headers.set("X-Cached-At", Date.now().toString());

    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    if (cached) return cached;
    return jsonErr(502, { ok: false, error: "Fetch error", detail: String(e) });
  } finally {
    clearTimeout(t);
  }
}

async function handleTCMB(ctx) {
  const TARGET = "https://www.tcmb.gov.tr/kurlar/today.xml";
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/tcmb-today");

  // Türkiye saati kontrolü (UTC+3)
  const turkeyHour = (new Date().getUTCHours() + 3) % 24;
  const isNightMode = turkeyHour >= 0 && turkeyHour < 6;

  const cached = await cache.match(cacheKey);
  
  // Gece modu: Cache varsa yaşına bakmadan kullan (sabaha kadar sabit)
  if (isNightMode) {
    if (cached) return cached;
    // Cache yoksa bir kere çek ve sabaha kadar bu veriyi kullan
  }

  // Gündüz modu: Normal cache kontrolü
  if (!isNightMode && cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    if (cachedAt && Date.now() - Number(cachedAt) < 60_000) return cached;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4500);

  try {
    const upstream = await fetch(TARGET, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.tcmb.gov.tr/"
      }
    });

    if (!upstream.ok) {
      if (cached) return cached;
      return jsonErr(502, { ok: false, error: "TCMB upstream failed", status: upstream.status });
    }

    const xmlText = await upstream.text();
    const jsonData = tcmbXmlToJson(xmlText);

    const res = new Response(JSON.stringify(jsonData), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=30",
        "X-Cached-At": Date.now().toString()
      }
    });

    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    if (cached) return cached;
    return jsonErr(502, { ok: false, error: "TCMB fetch error", detail: String(e) });
  } finally {
    clearTimeout(t);
  }
}

function tcmbXmlToJson(xmlText) {
  const dateMatch = xmlText.match(/<Tarih_Date[^>]*Tarih="([^"]+)"/i);
  const rawDate = dateMatch ? dateMatch[1] : null;
  
  const now = new Date();
  const tarih = rawDate 
    ? `${rawDate.split('.').join('-')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
    : `${now.getDate().toString().padStart(2, '0')}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

  const data = {};
  const blocks = xmlText.match(/<Currency[\s\S]*?<\/Currency>/gi) || [];

  for (const block of blocks) {
    const code = pickAttr(block, "CurrencyCode") || pickAttr(block, "Kod");
    if (!code) continue;

    const key = `${code}TRY`;
    const alis = numOrNull(pickTag(block, "ForexBuying"));
    const satis = numOrNull(pickTag(block, "ForexSelling"));
    const dusuk = numOrNull(pickTag(block, "BanknoteBuying"));
    const yuksek = numOrNull(pickTag(block, "BanknoteSelling"));
    const kapanis = numOrNull(pickTag(block, "BanknoteSelling"));
    const isim = pickTag(block, "Isim") || pickTag(block, "CurrencyName") || "";

    data[key] = {
      code: key,
      adi: isim,
      alis: alis,
      satis: satis,
      tarih: tarih,
      dir: {
        alis_dir: "",
        satis_dir: ""
      },
      dusuk: dusuk,
      yuksek: yuksek,
      kapanis: kapanis
    };
  }

  return {
    meta: {
      time: Date.now(),
      tarih: tarih
    },
    data: data
  };
}

function pickAttr(xml, attrName) {
  const m = xml.match(new RegExp(`${attrName}="([^"]+)"`, "i"));
  return m ? m[1] : null;
}

function pickTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

function decodeXmlEntities(s) {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(",", "."));
  return Number.isFinite(x) ? x : null;
}

function jsonErr(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// Cache yenileme fonksiyonu
async function refreshCache(ctx, endpoint) {
  const cache = caches.default;
  let cacheKey, TARGET, processor;

  if (endpoint === "haremaltin") {
    cacheKey = new Request("https://cache.local/haremaltin");
    TARGET = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";
    processor = (res) => res; // JSON zaten hazır
  } else if (endpoint === "tcmb") {
    cacheKey = new Request("https://cache.local/tcmb-today");
    TARGET = "https://www.tcmb.gov.tr/kurlar/today.xml";
    processor = async (res) => {
      const xmlText = await res.text();
      const jsonData = tcmbXmlToJson(xmlText);
      return new Response(JSON.stringify(jsonData), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=30",
          "X-Cached-At": Date.now().toString()
        }
      });
    };
  }

  try {
    const upstream = await fetch(TARGET, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": endpoint === "tcmb" ? "application/xml,text/xml;q=0.9,*/*;q=0.8" : "application/json,text/plain,*/*"
      }
    });

    if (!upstream.ok) {
      console.error(`Failed to refresh ${endpoint}: ${upstream.status}`);
      return;
    }

    const processedResponse = await processor(upstream);
    
    if (endpoint === "haremaltin") {
      const res = new Response(processedResponse.body, processedResponse);
      res.headers.set("Content-Type", "application/json; charset=utf-8");
      res.headers.set("Cache-Control", "public, max-age=5");
      res.headers.set("X-Cached-At", Date.now().toString());
      await cache.put(cacheKey, res);
    } else {
      await cache.put(cacheKey, processedResponse);
    }

    console.log(`Successfully refreshed cache for ${endpoint}`);
  } catch (e) {
    console.error(`Error refreshing ${endpoint}:`, e);
  }
}

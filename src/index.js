export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/haremaltin") return handleHaremAltin(ctx);
    if (url.pathname === "/tcmb") return handleTCMB(ctx);
    if (url.pathname === "/truncgil") return handleTruncgil(ctx);

    return new Response(
      JSON.stringify({ ok: false, routes: ["/haremaltin", "/tcmb", "/truncgil"] }),
      { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
};

async function handleHaremAltin(ctx) {
  const TARGET = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/haremaltin");

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    // Cache'i 30 saniye boyunca kullan
    if (cachedAt && Date.now() - Number(cachedAt) < 30_000) return cached;
  }

  // Retry mekanizması: 2 deneme, her biri max 15 saniye
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);

      try {
        const upstream = await fetch(TARGET, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json,text/plain,*/*",
            "Referer": "https://canlipiyasalar.haremaltin.com/"
          }
        });

        clearTimeout(t);

        if (!upstream.ok) {
          if (attempt === 2 && cached) return cached;
          if (attempt === 2) return jsonErr(502, { ok: false, error: "Upstream failed", status: upstream.status });
          continue; // Tekrar dene
        }

        const res = new Response(upstream.body, upstream);
        res.headers.set("Content-Type", "application/json; charset=utf-8");
        res.headers.set("Cache-Control", "public, max-age=10");
        res.headers.set("X-Cached-At", Date.now().toString());

        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (fetchErr) {
        clearTimeout(t);
        if (attempt === 2) throw fetchErr;
        // İlk denemede hata aldıysak, 100ms bekleyip tekrar dene
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (e) {
      if (attempt === 2) {
        // Tüm denemeler başarısız, eski cache varsa döndür
        if (cached) return cached;
        return jsonErr(502, { ok: false, error: "Fetch error", detail: String(e) });
      }
    }
  }
}

async function handleTruncgil(ctx) {
  const TARGET = "https://finans.truncgil.com/v4/today.json";
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/truncgil");

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    // Cache'i 30 saniye boyunca kullan
    if (cachedAt && Date.now() - Number(cachedAt) < 30_000) return cached;
  }

  // Retry mekanizması: 2 deneme, her biri max 15 saniye
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);

      try {
        const upstream = await fetch(TARGET, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json,text/plain,*/*",
            "Referer": "https://finans.truncgil.com/"
          }
        });

        clearTimeout(t);

        if (!upstream.ok) {
          if (attempt === 2 && cached) return cached;
          if (attempt === 2) return jsonErr(502, { ok: false, error: "Upstream failed", status: upstream.status });
          continue; // Tekrar dene
        }

        const jsonText = await upstream.text();
        const jsonData = truncgilToStandardFormat(jsonText);

        const res = new Response(JSON.stringify(jsonData), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=10",
            "X-Cached-At": Date.now().toString()
          }
        });

        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (fetchErr) {
        clearTimeout(t);
        if (attempt === 2) throw fetchErr;
        // İlk denemede hata aldıysak, 100ms bekleyip tekrar dene
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (e) {
      if (attempt === 2) {
        // Tüm denemeler başarısız, eski cache varsa döndür
        if (cached) return cached;
        return jsonErr(502, { ok: false, error: "Fetch error", detail: String(e) });
      }
    }
  }
}

async function handleTCMB(ctx) {
  const TARGET = "https://www.tcmb.gov.tr/kurlar/today.xml";
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/tcmb-today");

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    // Cache'i 5 dakika boyunca kullan
    if (cachedAt && Date.now() - Number(cachedAt) < 300_000) return cached;
  }

  // Retry mekanizması: 2 deneme, her biri max 15 saniye
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);

      try {
        const upstream = await fetch(TARGET, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
            "Referer": "https://www.tcmb.gov.tr/"
          }
        });

        clearTimeout(t);

        if (!upstream.ok) {
          if (attempt === 2 && cached) return cached;
          if (attempt === 2) return jsonErr(502, { ok: false, error: "TCMB upstream failed", status: upstream.status });
          continue; // Tekrar dene
        }

        const xmlText = await upstream.text();
        const jsonData = tcmbXmlToJson(xmlText);

        const res = new Response(JSON.stringify(jsonData), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=60",
            "X-Cached-At": Date.now().toString()
          }
        });

        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (fetchErr) {
        clearTimeout(t);
        if (attempt === 2) throw fetchErr;
        // İlk denemede hata aldıysak, 100ms bekleyip tekrar dene
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (e) {
      if (attempt === 2) {
        // Tüm denemeler başarısız, eski cache varsa döndür
        if (cached) return cached;
        return jsonErr(502, { ok: false, error: "TCMB fetch error", detail: String(e) });
      }
    }
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

function truncgilToStandardFormat(jsonText) {
  try {
    const rawData = JSON.parse(jsonText);
    const now = new Date();
    const tarih = `${now.getDate().toString().padStart(2, '0')}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    
    const data = {};
    
    // Truncgil API formatını standart formata çevir
    for (const [key, value] of Object.entries(rawData)) {
      if (typeof value === 'object' && value !== null) {
        data[key] = {
          code: key,
          adi: value.Name || value.name || value.adi || key,
          alis: numOrNull(value.Buying || value.buying || value.alis),
          satis: numOrNull(value.Selling || value.selling || value.satis),
          tarih: tarih,
          dir: {
            alis_dir: value.ChangeDirection || value.changeDirection || "",
            satis_dir: value.ChangeDirection || value.changeDirection || ""
          },
          dusuk: numOrNull(value.Low || value.low || value.dusuk),
          yuksek: numOrNull(value.High || value.high || value.yuksek),
          kapanis: numOrNull(value.Rate || value.rate || value.Selling || value.selling || value.satis)
        };
      }
    }
    
    return {
      meta: {
        time: Date.now(),
        tarih: tarih
      },
      data: data
    };
  } catch (e) {
    // Parse hatası durumunda orijinal veriyi döndür
    return JSON.parse(jsonText);
  }
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

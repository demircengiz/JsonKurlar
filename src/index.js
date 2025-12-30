export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/haremaltin") return handleHaremAltin(ctx);
    if (url.pathname === "/tcmb") return handleTCMB(ctx);

    return new Response(
      JSON.stringify({ ok: false, routes: ["/haremaltin", "/tcmb"] }),
      { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
};

async function handleHaremAltin(ctx) {
  // Alternatif: Altınlar için farklı kaynaklardan veri al
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/haremaltin");

  // Önce cache'i kontrol et
  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    // Eğer cache 2 dakikadan yeni ise direkt döndür
    if (cachedAt && Date.now() - Number(cachedAt) < 120_000) {
      return cached;
    }
  }

  try {
    // Bigpara'dan altın fiyatlarını çek
    const upstream = await fetch("https://bigpara.hurriyet.com.tr/altin/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      cf: {
        cacheTtl: 60
      }
    });

    if (!upstream.ok) {
      if (cached) return cached;
      return jsonErr(502, { ok: false, error: "Upstream failed", status: upstream.status });
    }

    const html = await upstream.text();
    const data = parseAltinHTML(html);

    const res = new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "X-Cached-At": Date.now().toString()
      }
    });

    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    if (cached) return cached;
    return jsonErr(502, { ok: false, error: "Fetch error", detail: e.message || String(e) });
  }
}

async function handleTCMB(ctx) {
  const TARGET = "https://www.tcmb.gov.tr/kurlar/today.xml";
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/tcmb-today");

  // Önce cache'i kontrol et
  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    // Eğer cache 5 dakikadan yeni ise direkt döndür
    if (cachedAt && Date.now() - Number(cachedAt) < 300_000) {
      return cached;
    }
  }

  try {
    // AbortController olmadan fetch yap
    const upstream = await fetch(TARGET, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.tcmb.gov.tr/"
      },
      cf: {
        cacheTtl: 180,
        cacheEverything: true
      }
    });

    if (!upstream.ok) {
      // Upstream başarısız, cache varsa döndür (süresi dolmuş olsa bile)
      if (cached) return cached;
      return jsonErr(502, { ok: false, error: "TCMB upstream failed", status: upstream.status });
    }

    const xmlText = await upstream.text();
    const jsonData = tcmbXmlToJson(xmlText);

    const res = new Response(JSON.stringify(jsonData), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=180",
        "X-Cached-At": Date.now().toString()
      }
    });

    // Cache'i async olarak güncelle
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    // Hata oluştu, cache varsa döndür (süresi dolmuş olsa bile)
    if (cached) return cached;
    return jsonErr(502, { ok: false, error: "TCMB fetch error", detail: e.message || String(e) });
  }
}

function parseAltinHTML(html) {
  const data = {};
  const now = new Date();
  const tarih = `${now.getDate().toString().padStart(2, '0')}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

  // Gram Altın
  const gramMatch = html.match(/gram-altin[\s\S]{0,500}?data-alis="([^"]+)"[\s\S]{0,100}?data-satis="([^"]+)"/i);
  if (gramMatch) {
    data['GRAMTIN'] = {
      code: 'GRAMTIN',
      adi: 'Gram Altın',
      alis: parseFloat(gramMatch[1].replace(',', '.')) || null,
      satis: parseFloat(gramMatch[2].replace(',', '.')) || null,
      tarih: tarih
    };
  }

  // Çeyrek Altın
  const ceyrekMatch = html.match(/ceyrek-altin[\s\S]{0,500}?data-alis="([^"]+)"[\s\S]{0,100}?data-satis="([^"]+)"/i);
  if (ceyrekMatch) {
    data['CEYREKTIN'] = {
      code: 'CEYREKTIN',
      adi: 'Çeyrek Altın',
      alis: parseFloat(ceyrekMatch[1].replace(',', '.')) || null,
      satis: parseFloat(ceyrekMatch[2].replace(',', '.')) || null,
      tarih: tarih
    };
  }

  // Yarım Altın
  const yarimMatch = html.match(/yarim-altin[\s\S]{0,500}?data-alis="([^"]+)"[\s\S]{0,100}?data-satis="([^"]+)"/i);
  if (yarimMatch) {
    data['YARIMTIN'] = {
      code: 'YARIMTIN',
      adi: 'Yarım Altın',
      alis: parseFloat(yarimMatch[1].replace(',', '.')) || null,
      satis: parseFloat(yarimMatch[2].replace(',', '.')) || null,
      tarih: tarih
    };
  }

  // Tam Altın
  const tamMatch = html.match(/tam-altin[\s\S]{0,500}?data-alis="([^"]+)"[\s\S]{0,100}?data-satis="([^"]+)"/i);
  if (tamMatch) {
    data['TAMTIN'] = {
      code: 'TAMTIN',
      adi: 'Tam Altın',
      alis: parseFloat(tamMatch[1].replace(',', '.')) || null,
      satis: parseFloat(tamMatch[2].replace(',', '.')) || null,
      tarih: tarih
    };
  }

  return {
    meta: {
      time: Date.now(),
      tarih: tarih,
      source: "bigpara.hurriyet.com.tr"
    },
    data: data
  };
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

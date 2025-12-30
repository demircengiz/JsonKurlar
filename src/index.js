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
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/haremaltin");

  // Önce cache'i kontrol et
  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    if (cachedAt && Date.now() - Number(cachedAt) < 120_000) {
      return cached;
    }
  }

  try {
    // GetGold, GetCurrency ve GetMain SOAP isteklerini paralel yap
    const [goldResponse, currencyResponse, mainResponse] = await Promise.all([
      fetchAltinkaynakSOAP("GetGold"),
      fetchAltinkaynakSOAP("GetCurrency"),
      fetchAltinkaynakSOAP("GetMain")
    ]);

    const now = new Date();
    const tarih = `${now.getDate().toString().padStart(2, '0')}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    const goldData = parseAltinkaynakXML(goldResponse, "GetGoldResult");
    const currencyData = parseAltinkaynakXML(currencyResponse, "GetCurrencyResult");
    const mainData = parseAltinkaynakXML(mainResponse, "GetMainResult");

    const combinedData = {
      meta: {
        time: Date.now(),
        tarih: tarih,
        source: "altinkaynak.com"
      },
      gold: goldData,
      currency: currencyData,
      main: mainData
    };

    const res = new Response(JSON.stringify(combinedData), {
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

async function fetchAltinkaynakSOAP(method) {
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Header>
    <AuthHeader xmlns="http://data.altinkaynak.com/">
      <Username>AltinkaynakWebServis</Username>
      <Password>AltinkaynakWebServis</Password>
    </AuthHeader>
  </soap:Header>
  <soap:Body>
    <${method} xmlns="http://data.altinkaynak.com/" />
  </soap:Body>
</soap:Envelope>`;

  const response = await fetch("http://data.altinkaynak.com/DataService.asmx", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `http://data.altinkaynak.com/${method}`
    },
    body: soapBody,
    cf: {
      cacheTtl: 60
    }
  });

  if (!response.ok) {
    throw new Error(`SOAP request failed: ${response.status}`);
  }

  return await response.text();
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

function parseAltinkaynakXML(xmlText, resultTag) {
  // SOAP response'tan XML içeriğini çıkar
  const resultMatch = xmlText.match(new RegExp(`<${resultTag}>(.*?)</${resultTag}>`, 's'));
  if (!resultMatch) {
    return {};
  }

  // HTML entities'i decode et
  const decodedXml = resultMatch[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

  const data = {};
  
  // Her bir <Kur> bloğunu parse et
  const kurBlocks = decodedXml.match(/<Kur>[\s\S]*?<\/Kur>/g) || [];
  
  for (const block of kurBlocks) {
    const kod = (block.match(/<Kod>(.*?)<\/Kod>/) || [])[1];
    const aciklama = (block.match(/<Aciklama>(.*?)<\/Aciklama>/) || [])[1];
    const alis = (block.match(/<Alis>(.*?)<\/Alis>/) || [])[1];
    const satis = (block.match(/<Satis>(.*?)<\/Satis>/) || [])[1];
    const guncellenme = (block.match(/<GuncellenmeZamani>(.*?)<\/GuncellenmeZamani>/) || [])[1];

    if (kod) {
      data[kod] = {
        code: kod,
        adi: aciklama || '',
        alis: alis ? parseFloat(alis) : null,
        satis: satis ? parseFloat(satis) : null,
        guncellenme: guncellenme || ''
      };
    }
  }

  return data;
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

/** Загрузка официальных курсов ЦБ → единиц валюты за 1 EUR. */

const FETCH_TIMEOUT_MS = 12000;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function nbkDateParam(date = new Date()) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

/** ECB reference rates (via Frankfurter mirror). */
async function fetchEcbUsdPln() {
  const data = await fetchJson('https://api.frankfurter.app/latest?from=EUR&to=USD,PLN');
  const usd = Number(data?.rates?.USD);
  const pln = Number(data?.rates?.PLN);
  if (!usd || !pln) {
    throw new Error('ECB rates missing');
  }
  return {
    rates: { USD: usd, PLN: pln },
    date: String(data.date ?? todayIso()).slice(0, 10),
    source: 'ECB',
  };
}

/** ЦБ РФ — RUB за 1 EUR. */
async function fetchCbrRubPerEur() {
  const data = await fetchJson('https://www.cbr-xml-daily.ru/daily_json.js');
  const eur = data?.Valute?.EUR;
  const value = Number(eur?.Value);
  const nominal = Number(eur?.Nominal) || 1;
  if (!value) {
    throw new Error('CBR EUR missing');
  }
  return {
    rate: value / nominal,
    date: String(data.Date ?? todayIso()).slice(0, 10),
    source: 'CBR',
  };
}

/** НБРБ — BYN за 1 EUR. */
async function fetchNbrbBynPerEur() {
  const data = await fetchJson('https://www.nbrb.by/api/exrates/rates/EUR?parammode=2');
  const value = Number(data?.Cur_OfficialRate);
  const scale = Number(data?.Cur_Scale) || 1;
  if (!value) {
    throw new Error('NBRB EUR missing');
  }
  const rawDate = data?.Date;
  const date =
    rawDate && typeof rawDate === 'string'
      ? rawDate.slice(0, 10)
      : todayIso();
  return {
    rate: value / scale,
    date,
    source: 'NBRB',
  };
}

/** НБК — KZT за 1 EUR. */
async function fetchNbkKztPerEur() {
  const xml = await fetchText(
    `https://nationalbank.kz/rss/get_rates.cfm?fdate=${nbkDateParam()}`,
  );
  const itemMatch = xml.match(
    /<item>[\s\S]*?<title>EUR<\/title>[\s\S]*?<description>([\d.]+)<\/description>[\s\S]*?<quant>(\d+)<\/quant>/i,
  );
  if (!itemMatch) {
    throw new Error('NBK EUR missing');
  }
  const description = Number(itemMatch[1]);
  const quant = Number(itemMatch[2]) || 1;
  if (!description) {
    throw new Error('NBK EUR invalid');
  }
  return {
    rate: description / quant,
    date: todayIso(),
    source: 'NBK',
  };
}

/**
 * @param {Record<string, number>} fallback
 * @returns {Promise<{ rates: Record<string, number>, date: string, source: string }>}
 */
async function fetchCentralBankRates(fallback) {
  const rates = { EUR: 1 };
  const sourceLabels = [];
  const dates = [];

  const apply = (code, rate, date, source, usedFallback = false) => {
    const label = usedFallback ? `${source} (fallback)` : source;
    if (!sourceLabels.includes(label)) {
      sourceLabels.push(label);
    }
    if (rate > 0) {
      rates[code] = rate;
    } else if (fallback[code]) {
      rates[code] = fallback[code];
    }
    if (date) {
      dates.push(date);
    }
  };

  const [ecb, cbr, nbrb, nbk] = await Promise.allSettled([
    fetchEcbUsdPln(),
    fetchCbrRubPerEur(),
    fetchNbrbBynPerEur(),
    fetchNbkKztPerEur(),
  ]);

  if (ecb.status === 'fulfilled') {
    apply('USD', ecb.value.rates.USD, ecb.value.date, ecb.value.source);
    apply('PLN', ecb.value.rates.PLN, ecb.value.date, ecb.value.source);
  } else {
    apply('USD', fallback.USD, null, 'ECB', true);
    apply('PLN', fallback.PLN, null, 'ECB', true);
  }

  if (cbr.status === 'fulfilled') {
    apply('RUB', cbr.value.rate, cbr.value.date, cbr.value.source);
  } else {
    apply('RUB', fallback.RUB, null, 'CBR', true);
  }

  if (nbrb.status === 'fulfilled') {
    apply('BYN', nbrb.value.rate, nbrb.value.date, nbrb.value.source);
  } else {
    apply('BYN', fallback.BYN, null, 'NBRB', true);
  }

  if (nbk.status === 'fulfilled') {
    apply('KZT', nbk.value.rate, nbk.value.date, nbk.value.source);
  } else {
    apply('KZT', fallback.KZT, null, 'NBK', true);
  }

  const date = dates.sort().reverse()[0] ?? todayIso();

  return {
    rates,
    date,
    source: sourceLabels.join(', '),
  };
}

module.exports = {
  fetchCentralBankRates,
  fetchEcbUsdPln,
  fetchCbrRubPerEur,
  fetchNbrbBynPerEur,
  fetchNbkKztPerEur,
};

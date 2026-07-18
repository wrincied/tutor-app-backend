/**
 * Local finance playground — live Income / Expenses / Gross / Net,
 * lesson validation, and tax estimates for all regimes.
 *
 * Usage: node scripts/finance-playground.js
 * Open:  http://localhost:3055
 */
const http = require('node:http');
const { URL } = require('node:url');
const {
  lessonIncomeForStatus,
  lessonScheduledRevenueForStatus,
  normalizeLessonStatus,
  lessonRevenueFromSnapshot,
} = require('../src/utils/lessonSnapshot');
const {
  classifyFinanceOrphan,
  expandFinanceOccurrences,
  financeOccurrenceRange,
} = require('../src/utils/lessonRecurrence');
const { computeTaxProjection } = require('../src/utils/financeTax');
const { ALLOWED_TAX_MODES } = require('../src/utils/userProfile');

const PORT = Number(process.env.FINANCE_PLAYGROUND_PORT || 3055);

function money(n) {
  return Number(n || 0);
}

function analyze(payload) {
  const lessons = Array.isArray(payload.lessons) ? payload.lessons : [];
  const expenses = Array.isArray(payload.expenses) ? payload.expenses : [];
  const from = payload.from ? new Date(payload.from) : null;
  const to = payload.to ? new Date(payload.to) : null;
  const { start, end } = financeOccurrenceRange(from, to);

  let totalIncome = 0;
  let scheduledIncome = 0;
  const lessonRows = [];

  for (const raw of lessons) {
    const lesson = {
      ...raw,
      lesson_duration: Number(raw.lesson_duration ?? 60),
      lesson_price: Number(raw.lesson_price ?? 0),
      price_mode: raw.price_mode || (raw.rate_unit === 'lesson' ? 'fixed' : 'hourly'),
      status: normalizeLessonStatus(raw.status),
    };
    const orphan = classifyFinanceOrphan(lesson);
    if (orphan) {
      lessonRows.push({
        id: lesson.id || lesson.studentName || 'lesson',
        studentName: lesson.studentName || '—',
        status: lesson.status,
        scheduledAt: lesson.scheduledAt || null,
        durationMinutes: lesson.lesson_duration,
        ratePerHour: lesson.lesson_price,
        revenue: 0,
        incomeType: 'none',
        hiddenReason: orphan,
        note:
          orphan === 'no_schedule'
            ? 'Нет даты в расписании — не в суммах и не в календаре'
            : 'Сломанное правило повторения — не в календаре',
        occurrences: 0,
      });
      continue;
    }

    const occurrences = expandFinanceOccurrences(lesson, start, end);
    if (occurrences.length === 0) {
      lessonRows.push({
        id: lesson.id || lesson.studentName || 'lesson',
        studentName: lesson.studentName || '—',
        status: lesson.status,
        scheduledAt: lesson.scheduledAt || null,
        durationMinutes: lesson.lesson_duration,
        ratePerHour: lesson.lesson_price,
        revenue: 0,
        incomeType: 'none',
        hiddenReason: null,
        note: 'В выбранном периоде нет вхождений',
        occurrences: 0,
      });
      continue;
    }

    for (const occ of occurrences) {
      const status = normalizeLessonStatus(occ.status);
      const earned = lessonIncomeForStatus(lesson, status);
      const planned = lessonScheduledRevenueForStatus(lesson, status);
      totalIncome += earned;
      scheduledIncome += planned;
      lessonRows.push({
        id: `${lesson.id || 'l'}:${occ.occurrenceDate}`,
        studentName: lesson.studentName || '—',
        status,
        scheduledAt: occ.scheduledAt,
        durationMinutes: occ.durationMinutes,
        ratePerHour: lesson.lesson_price,
        revenue: earned + planned,
        formula: (() => {
          const amount = lessonRevenueFromSnapshot({
            ...lesson,
            lesson_duration: occ.durationMinutes,
          });
          if (lesson.price_mode === 'fixed' || lesson.rate_unit === 'lesson') {
            return `fixed ${lesson.lesson_price} = ${amount.toFixed(2)}`;
          }
          return `${lesson.lesson_price} × ${occ.durationMinutes}/60 = ${amount.toFixed(2)}`;
        })(),
        incomeType: earned > 0 ? 'completed' : planned > 0 ? 'scheduled' : 'none',
        hiddenReason: null,
        note: occ.scheduleDerived
          ? 'Время выведено из даты создания'
          : status === 'completed'
            ? 'Идёт в Поступление (факт) и в Брутто'
            : status === 'scheduled'
              ? 'Идёт только в Поступление (план), НЕ в Брутто'
              : 'Пропуск / отмена — 0 в суммах',
        occurrences: 1,
        scheduleDerived: Boolean(occ.scheduleDerived),
      });
    }
  }

  const totalExpenses = expenses.reduce((sum, e) => sum + money(e.amount), 0);
  const combinedIncome = totalIncome + scheduledIncome;
  const grossProfit = totalIncome - totalExpenses;
  const taxMode = payload.tax_mode || 'at-self-employed';
  const tax = computeTaxProjection(taxMode, { grossProfit, totalIncome });

  return {
    period: {
      from: from ? from.toISOString().slice(0, 10) : null,
      to: to ? to.toISOString().slice(0, 10) : null,
    },
    tax_mode: taxMode,
    availableTaxModes: [...ALLOWED_TAX_MODES],
    kpis: {
      incomeCombined: combinedIncome,
      incomeCompleted: totalIncome,
      incomePlanned: scheduledIncome,
      expenses: totalExpenses,
      gross: grossProfit,
      net: tax?.netProfit ?? grossProfit,
    },
    tax: tax
      ? {
          mode: tax.mode,
          socialInsuranceRate: tax.socialInsuranceRate,
          socialInsurance: tax.socialInsurance,
          taxableBase: tax.taxableBase,
          incomeTax: tax.incomeTax,
          netProfit: tax.netProfit,
        }
      : null,
    formulas: {
      income: 'Поступление = проведённые + запланированные',
      expenses: 'Траты = сумма расходов за период',
      gross: 'Брутто = только проведённые − траты (план не входит)',
      net: 'Нетто = Брутто − соцвзносы − налог (по выбранному режиму)',
    },
    lessons: lessonRows,
    expenses,
  };
}

const DEFAULT_PAYLOAD = {
  tax_mode: 'at-self-employed',
  from: null,
  to: null,
  lessons: [
    {
      id: 'c1',
      studentName: 'Anna',
      status: 'completed',
      scheduledAt: new Date().toISOString(),
      lesson_price: 40,
      lesson_duration: 60,
    },
    {
      id: 's1',
      studentName: 'Boris',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      lesson_price: 50,
      lesson_duration: 90,
    },
    {
      id: 'orphan',
      studentName: 'Without schedule',
      status: 'completed',
      lesson_price: 80,
      lesson_duration: 60,
    },
    {
      id: 'missed',
      studentName: 'Clara',
      status: 'missed',
      scheduledAt: new Date(Date.now() - 86400000).toISOString(),
      lesson_price: 45,
      lesson_duration: 60,
    },
  ],
  expenses: [
    { title: 'Zoom', amount: 15 },
    { title: 'Materials', amount: 25 },
  ],
};

const HTML = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Finance Playground · localhost</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --panel: #fff;
      --text: #1a1d21;
      --muted: #5b6570;
      --line: #d8dee4;
      --accent: #0f766e;
      --warn: #b45309;
      --bad: #b91c1c;
      --ok: #047857;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: linear-gradient(160deg, #e8f2ef, #f4f6f8 40%, #eef1f5);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--line);
      background: rgb(255 255 255 / 0.8);
      backdrop-filter: blur(8px);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { margin: 0; font-size: 1.35rem; }
    header p { margin: 0.35rem 0 0; color: var(--muted); font-size: 0.9rem; }
    main {
      display: grid;
      grid-template-columns: 1.1fr 1fr;
      gap: 1rem;
      padding: 1rem 1.5rem 2rem;
      max-width: 1280px;
      margin: 0 auto;
    }
    @media (max-width: 960px) {
      main { grid-template-columns: 1fr; }
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1rem;
    }
    .panel h2 {
      margin: 0 0 0.75rem;
      font-size: 1rem;
    }
    label {
      display: block;
      font-size: 0.75rem;
      color: var(--muted);
      margin-bottom: 0.25rem;
    }
    textarea, input, select, button {
      font: inherit;
    }
    textarea {
      width: 100%;
      min-height: 280px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0.75rem;
      resize: vertical;
      font-family: ui-monospace, Consolas, monospace;
      font-size: 0.8rem;
      line-height: 1.4;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.75rem;
    }
    button {
      border: none;
      border-radius: 8px;
      padding: 0.55rem 0.9rem;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
    }
    button.secondary {
      background: #fff;
      color: var(--text);
      border: 1px solid var(--line);
    }
    .kpis {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.65rem;
    }
    .kpi {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 0.75rem;
      background: #fafbfc;
    }
    .kpi span { display: block; color: var(--muted); font-size: 0.75rem; }
    .kpi strong { font-size: 1.15rem; font-variant-numeric: tabular-nums; }
    .kpi small { display: block; margin-top: 0.25rem; color: var(--muted); font-size: 0.7rem; }
    .tax, .lessons { margin-top: 1rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
    }
    th, td {
      text-align: left;
      padding: 0.45rem 0.35rem;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; }
    .tag {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 999px;
      font-size: 0.7rem;
      background: #e5e7eb;
    }
    .tag.ok { background: #d1fae5; color: var(--ok); }
    .tag.warn { background: #ffedd5; color: var(--warn); }
    .tag.bad { background: #fee2e2; color: var(--bad); }
    .formulas {
      margin-top: 0.75rem;
      font-size: 0.8rem;
      color: var(--muted);
      line-height: 1.5;
    }
    .error {
      color: var(--bad);
      font-size: 0.85rem;
      margin-top: 0.5rem;
    }
    .live {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.75rem;
      color: var(--ok);
      margin-left: 0.5rem;
    }
    .live::before {
      content: "";
      width: 0.45rem;
      height: 0.45rem;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 0 3px rgb(4 120 87 / 0.2);
    }
  </style>
</head>
<body>
  <header>
    <h1>Finance Playground <span class="live">live</span></h1>
    <p>
      Реальный расчёт из backend utils: валидация уроков, KPI и налоги по всем режимам.
      Правьте JSON слева (включая tax_mode) — справа пересчёт мгновенно.
    </p>
  </header>
  <main>
    <section class="panel">
      <h2>Входные данные (JSON)</h2>
      <label for="taxMode">Налоговый режим</label>
      <select id="taxMode" style="width:100%;margin-bottom:0.75rem;padding:0.5rem;border:1px solid var(--line);border-radius:8px;">
        <option value="at-self-employed">AT — self-employed</option>
        <option value="de-kleinunternehmer">DE — Kleinunternehmer</option>
        <option value="pl-ryczalt">PL — ryczałt</option>
        <option value="ru-usn">RU — УСН</option>
        <option value="ru-ip">RU — ИП</option>
        <option value="by-ip">BY — ИП</option>
        <option value="kz-ip">KZ — ИП</option>
        <option value="ua-fop3">UA — ФОП 3 група</option>
      </select>
      <label for="payload">lessons + expenses</label>
      <textarea id="payload"></textarea>
      <div class="actions">
        <button type="button" id="reset">Сбросить демо</button>
        <button type="button" class="secondary" id="copy">Копировать JSON</button>
      </div>
      <p class="error" id="error" hidden></p>
      <div class="formulas" id="formulas"></div>
    </section>
    <section class="panel">
      <h2>KPI в реальном времени</h2>
      <div class="kpis" id="kpis"></div>
      <div class="tax">
        <h2>Налог и Нетто</h2>
        <div id="tax"></div>
      </div>
      <div class="lessons">
        <h2>Уроки: валидация и вклад в суммы</h2>
        <div id="lessons"></div>
      </div>
    </section>
  </main>
  <script>
    const DEFAULT = ${JSON.stringify(DEFAULT_PAYLOAD, null, 2)};
    const payloadEl = document.getElementById('payload');
    const errorEl = document.getElementById('error');
    const kpisEl = document.getElementById('kpis');
    const taxEl = document.getElementById('tax');
    const lessonsEl = document.getElementById('lessons');
    const formulasEl = document.getElementById('formulas');
    let timer = null;

    function eur(n) {
      return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'EUR',
        maximumFractionDigits: 2,
      }).format(n || 0);
    }

    function pct(n) {
      return new Intl.NumberFormat('ru-RU', {
        style: 'percent',
        maximumFractionDigits: 2,
      }).format(n || 0);
    }

    function tagFor(row) {
      if (row.hiddenReason) return '<span class="tag bad">' + row.hiddenReason + '</span>';
      if (row.incomeType === 'completed') return '<span class="tag ok">completed → брутто</span>';
      if (row.incomeType === 'scheduled') return '<span class="tag warn">scheduled → только поступление</span>';
      return '<span class="tag">0</span>';
    }

    function render(data) {
      const k = data.kpis;
      kpisEl.innerHTML = [
        ['Поступление', k.incomeCombined, 'факт ' + eur(k.incomeCompleted) + ' + план ' + eur(k.incomePlanned)],
        ['Траты', k.expenses, data.expenses.length + ' записей'],
        ['Брутто', k.gross, 'только факт − траты'],
        ['Нетто', k.net, 'после соцвзносов и налога'],
      ].map(([label, value, hint]) =>
        '<div class="kpi"><span>' + label + '</span><strong>' + eur(value) + '</strong><small>' + hint + '</small></div>'
      ).join('');

      const t = data.tax;
      if (!t) {
        taxEl.innerHTML = '<p class="formulas">Режим не задан — оценка Нетто недоступна.</p>';
      } else {
        let rows =
          '<tr><th>Режим</th><td>' + t.mode + '</td></tr>' +
          '<tr><th>Налоговая база</th><td>' + eur(t.taxableBase) + '</td></tr>';
        if (t.socialInsuranceRate > 0 || t.socialInsurance > 0) {
          rows +=
            '<tr><th>Соцвзносы (' + pct(t.socialInsuranceRate) + ')</th><td>−' + eur(t.socialInsurance) + '</td></tr>';
        }
        rows +=
          '<tr><th>Подоходный налог</th><td>−' + eur(t.incomeTax) + '</td></tr>' +
          '<tr><th>Нетто</th><td><strong>' + eur(t.netProfit) + '</strong></td></tr>';
        taxEl.innerHTML = '<table><tbody>' + rows + '</tbody></table>';
      }

      lessonsEl.innerHTML =
        '<table><thead><tr>' +
        '<th>Ученик</th><th>Статус</th><th>Сумма</th><th>Валидация</th><th>Заметка</th>' +
        '</tr></thead><tbody>' +
        data.lessons.map((row) =>
          '<tr>' +
          '<td>' + row.studentName + '<br><small>' + (row.scheduledAt || '—') + '</small></td>' +
          '<td>' + row.status + '</td>' +
          '<td>' + eur(row.revenue) + (row.formula ? '<br><small>' + row.formula + '</small>' : '') + '</td>' +
          '<td>' + tagFor(row) + '</td>' +
          '<td>' + (row.note || '') + '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table>';

      formulasEl.innerHTML = Object.values(data.formulas).map((f) => '• ' + f).join('<br>');
    }

    async function recalc() {
      try {
        const payload = JSON.parse(payloadEl.value);
        errorEl.hidden = true;
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'analyze failed');
        render(data);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = String(err.message || err);
      }
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(recalc, 250);
    }

    const taxModeEl = document.getElementById('taxMode');

    function syncTaxModeFromPayload() {
      try {
        const payload = JSON.parse(payloadEl.value);
        if (payload.tax_mode) taxModeEl.value = payload.tax_mode;
      } catch (_) {}
    }

    function applyTaxModeToPayload() {
      try {
        const payload = JSON.parse(payloadEl.value);
        payload.tax_mode = taxModeEl.value;
        payloadEl.value = JSON.stringify(payload, null, 2);
      } catch (_) {}
    }

    payloadEl.value = JSON.stringify(DEFAULT, null, 2);
    syncTaxModeFromPayload();
    payloadEl.addEventListener('input', () => {
      syncTaxModeFromPayload();
      schedule();
    });
    taxModeEl.addEventListener('change', () => {
      applyTaxModeToPayload();
      recalc();
    });
    document.getElementById('reset').addEventListener('click', () => {
      payloadEl.value = JSON.stringify(DEFAULT, null, 2);
      syncTaxModeFromPayload();
      recalc();
    });
    document.getElementById('copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(payloadEl.value);
    });
    recalc();
  </script>
</body>
</html>`;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    try {
      const payload = await readBody(req);
      sendJson(res, 200, analyze(payload));
    } catch (err) {
      sendJson(res, 400, { error: String(err.message || err) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/demo') {
    sendJson(res, 200, analyze(DEFAULT_PAYLOAD));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Finance playground: http://localhost:${PORT}`);
  console.log('Edit JSON in the browser — KPIs, lesson validation, and social insurance update live.');
  console.log('Real app finance page: http://localhost:4200/#/app/finance (requires login)');
});

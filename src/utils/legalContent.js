/** Allowed legal CMS document ids (path-safe). */
const LEGAL_DOC_IDS = Object.freeze(['datenschutz', 'impressum']);

/**
 * Default Datenschutzerklärung (DE) aligned with WKO checklist
 * (DSGVO Art. 13/14 + TKG Informationspflichten).
 * Placeholders [Firmenname], [Anschrift], [Telefon] must be filled in Impressum/CMS.
 */
const DATENSCHUTZ_BODY = [
  '# Datenschutzerklärung',
  '',
  'Der Schutz Ihrer Daten ist uns ein besonderes Anliegen. Wir verarbeiten Ihre Daten ausschließlich auf Grundlage der gesetzlichen Bestimmungen (DSGVO, DSG, TKG). In diesen Datenschutzinformationen informieren wir Sie über die wichtigsten Aspekte der Datenverarbeitung im Rahmen der Website und der Anwendung **Simple4U**.',
  '',
  'Die DSGVO und das TKG beziehen sich auf personenbezogene Daten. Die IP-Adresse gilt bereits als personenbezogenes Datum. Daher müssen die Informationspflichten auch dann erfüllt werden, wenn bloß die IP-Adresse verarbeitet wird.',
  '',
  'Stand: August 2026',
  '',
  '## 1. Verantwortlicher',
  '',
  'Verantwortlich für die Datenverarbeitung:',
  '',
  '- **[Firmenname]** (Betreiber von Simple4U)',
  '- Anschrift: **Köflacher Gasse 9, 2.218, 8020 Graz, Österreich**',
  '- Telefon: **+4366493290516**',
  '- E-Mail: **support@simple4u.com**',
  '',
  'Weitere Angaben finden Sie im [Impressum](/#/legal/impressum).',
  '',
  'Ein Datenschutzbeauftragter ist derzeit nicht bestellt. Anfragen zum Datenschutz richten Sie bitte an die oben genannte E-Mail-Adresse.',
  '',
  '## 2. Aufruf der Website (Server-Logdaten)',
  '',
  'Beim Besuch unserer Website bzw. der Web-App werden technisch erforderliche Verbindungsdaten verarbeitet, insbesondere:',
  '',
  '- IP-Adresse',
  '- Datum und Uhrzeit der Anfrage / Beginn und Ende der Sitzung',
  '- aufgerufene URL / technische Request-Metadaten',
  '- Browser- und Geräteinformationen (User-Agent), soweit vom Browser übermittelt',
  '',
  'Dies ist aus technischen Gründen zur Bereitstellung und Absicherung des Dienstes erforderlich und stellt ein berechtigtes Interesse im Sinne von Art. 6 Abs. 1 lit. f DSGVO dar. Soweit im Folgenden nichts anderes geregelt wird, werden diese Daten von uns nicht zu anderen Zwecken weiterverarbeitet.',
  '',
  '## 3. Nutzerkonto und Authentifizierung',
  '',
  'Für die Registrierung und Anmeldung verarbeiten wir:',
  '',
  '- E-Mail-Adresse',
  '- Name (soweit angegeben)',
  '- Authentifizierungs- und Sitzungsdaten (z. B. über Firebase Authentication)',
  '- Einwilligungsstatus zur Datenverarbeitung und zu Marketing-Cookies (soweit erteilt)',
  '',
  '**Zweck:** Erstellung und Verwaltung Ihres Kontos, Sicherheit, Vertragserfüllung.',
  '',
  '**Rechtsgrundlagen:** Art. 6 Abs. 1 lit. b DSGVO (Vertrag / vorvertragliche Maßnahmen), Art. 6 Abs. 1 lit. a DSGVO (Einwilligung, soweit eingeholt), Art. 6 Abs. 1 lit. f DSGVO (Sicherheit).',
  '',
  'Ohne Angabe der erforderlichen Kontodaten ist ein Vertragsschluss bzw. die Nutzung des Dienstes nicht möglich.',
  '',
  '## 4. CRM-Inhalte (Schüler, Unterricht, Finanzen)',
  '',
  'Im Rahmen der Nutzung von Simple4U speichern wir die von Ihnen eingegebenen Inhalte, insbesondere:',
  '',
  '- Schülerdaten (z. B. Name, Kontaktdaten, Notizen, Zeitzone, Tarif/Rate)',
  '- Unterrichts- und Kalenderdaten (Termine, Dauer, Status, Wiederholungen)',
  '- Finanz- und Abrechnungsdaten (Salden, Zahlungen, Ausgaben, Steuer-/Tarifeinstellungen)',
  '- optional Telegram-Verknüpfungsdaten (Chat-ID, Username), wenn Sie die Bot-Funktion aktiv nutzen',
  '',
  '**Zweck:** Bereitstellung von Terminplanung, Schülerverwaltung und Finanzübersicht.',
  '',
  '**Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung).',
  '',
  'Sie entscheiden, welche Inhalte Sie eingeben. Bitte geben Sie nur Daten ein, die für Ihre Tätigkeit erforderlich sind.',
  '',
  '## 5. Abonnement und Zahlungsabwicklung (Stripe)',
  '',
  'Für kostenpflichtige Abonnements (z. B. Simple4U Pro) werden Zahlungsvorgänge über den Zahlungsdienstleister **Stripe** abgewickelt. Dabei können an Stripe insbesondere Daten zur Zahlungsabwicklung (z. B. Zahlungsstatus, Kunden-/Session-Referenzen) übermittelt werden. Kartendaten werden in der Regel direkt bei Stripe verarbeitet und nicht von uns gespeichert.',
  '',
  '**Zweck:** Vertragsabwicklung, Abrechnung, Betrugsprävention.',
  '',
  '**Rechtsgrundlagen:** Art. 6 Abs. 1 lit. b DSGVO (Vertrag), Art. 6 Abs. 1 lit. c DSGVO (gesetzliche Aufbewahrungspflichten, soweit einschlägig), Art. 6 Abs. 1 lit. f DSGVO (Betrugsprävention).',
  '',
  '## 6. Telegram-Benachrichtigungen',
  '',
  'Wenn Sie den Telegram-Bot mit einem Schülerkonto verknüpfen, verarbeiten wir die dafür erforderlichen Identifikatoren (z. B. Chat-ID, Username, Verknüpfungszeitpunkt) und senden Benachrichtigungen (z. B. Erinnerungen, Zahlungsbelege), soweit von Ihnen konfiguriert.',
  '',
  '**Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO bzw. Art. 6 Abs. 1 lit. a DSGVO (soweit eine Einwilligung der betroffenen Person erforderlich ist).',
  '',
  'Die Verknüpfung kann jederzeit getrennt werden.',
  '',
  '## 7. Cookies und ähnliche Technologien',
  '',
  'Unsere Website verwendet Cookies und vergleichbare Speichertechniken.',
  '',
  '### 7.1 Technisch erforderliche Cookies / Speicherung',
  '',
  'Erforderlich für Anmeldung, Sitzung, Sicherheit und grundlegende Funktionen. Ohne diese kann der Dienst nicht betrieben werden. Rechtsgrundlage: berechtigtes Interesse (Art. 6 Abs. 1 lit. f DSGVO) sowie § 165 Abs. 3 TKG 2021 (technisch erforderliche Speicherung).',
  '',
  '### 7.2 Analyse / Produktverbesserung',
  '',
  'Soweit eingesetzt (z. B. Firebase Analytics), helfen diese Technologien zu verstehen, wie die Anwendung genutzt wird (z. B. welche Bildschirme häufiger geöffnet werden). Daten werden nach Möglichkeit pseudonymisiert/anonymisiert. Soweit nach TKG eine Einwilligung erforderlich ist, erfolgt die Verarbeitung nur nach Ihrer Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).',
  '',
  '### 7.3 Marketing-Cookies',
  '',
  'Marketing-Cookies werden nur gesetzt, wenn Sie im Onboarding bzw. in der Cookie-Hinweiszeile aktiv zugestimmt haben (Art. 6 Abs. 1 lit. a DSGVO). Die Einwilligung können Sie jederzeit widerrufen.',
  '',
  'Ausführlichere Informationen: [Cookie-Richtlinie](/#/legal/cookies).',
  '',
  '## 8. Empfänger und Auftragsverarbeiter',
  '',
  'Wir setzen Dienstleister ein, die Daten in unserem Auftrag oder als (Mit-)Verantwortliche verarbeiten können, insbesondere:',
  '',
  '- **Google Firebase / Google Cloud** (Authentifizierung, Datenbank, Hosting/Analytics – je nach Konfiguration)',
  '- **Stripe** (Zahlungsabwicklung)',
  '- **Telegram** (nur bei Nutzung der Bot-Funktion, Nachrichtenübermittlung)',
  '- ggf. Hosting-/Infrastrukturanbieter in der EU (z. B. Firebase App Hosting)',
  '',
  'Mit Auftragsverarbeitern schließen wir – soweit erforderlich – Verträge zur Auftragsverarbeitung ab.',
  '',
  '## 9. Übermittlung in Drittländer',
  '',
  'Einzelne Anbieter (insbesondere Google/Firebase, Stripe) können Daten in Drittländern verarbeiten, insbesondere in den USA. Soweit erforderlich, stützen wir uns auf Angemessenheitsbeschlüsse der Europäischen Kommission (z. B. EU-US Data Privacy Framework, soweit anwendbar) und/oder geeignete Garantien wie Standardvertragsklauseln (SCC).',
  '',
  'Nähere Informationen finden Sie in den Datenschutzhinweisen der jeweiligen Anbieter.',
  '',
  '## 10. Speicherdauer',
  '',
  '- **Kontodaten und CRM-Inhalte:** solange Ihr Konto besteht bzw. bis zur Löschung / bis Sie die Löschung verlangen, soweit keine längeren gesetzlichen Aufbewahrungspflichten entgegenstehen.',
  '- **Zahlungs- und Vertragsdaten:** grundsätzlich bis zum Ablauf steuerrechtlicher Aufbewahrungsfristen (in Österreich typischerweise bis zu 7 Jahre), soweit einschlägig.',
  '- **Server-/Sicherheitslogs:** nur so lange, wie für Betrieb und Sicherheit erforderlich.',
  '- **Cookies:** je nach Art für die Dauer der Sitzung oder bis zum Ablauf/Löschung; Marketing-Cookies nur bei Einwilligung und gemäß Cookie-Hinweis.',
  '',
  'Nach Abbruch einer Registrierung oder Beendigung des Nutzungsverhältnisses löschen bzw. anonymisieren wir Daten, soweit keine gesetzliche Pflicht zur weiteren Speicherung besteht.',
  '',
  '## 11. Ihre Rechte',
  '',
  'Ihnen stehen bezüglich Ihrer von uns verarbeiteten Daten grundsätzlich die Rechte auf:',
  '',
  '- Auskunft (Art. 15 DSGVO)',
  '- Berichtigung (Art. 16 DSGVO)',
  '- Löschung (Art. 17 DSGVO)',
  '- Einschränkung der Verarbeitung (Art. 18 DSGVO)',
  '- Datenübertragbarkeit (Art. 20 DSGVO)',
  '- Widerspruch (Art. 21 DSGVO)',
  '- Widerruf einer erteilten Einwilligung (Art. 7 Abs. 3 DSGVO) – die Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt unberührt',
  '',
  'Zur Ausübung Ihrer Rechte kontaktieren Sie uns unter **support@simple4u.com**.',
  '',
  '## 12. Beschwerderecht',
  '',
  'Wenn Sie der Ansicht sind, dass die Verarbeitung Ihrer Daten gegen das Datenschutzrecht verstößt, können Sie sich bei uns oder bei einer Aufsichtsbehörde beschweren. In Österreich ist dies insbesondere die **Datenschutzbehörde** ([https://www.dsb.gv.at](https://www.dsb.gv.at)).',
  '',
  '## 13. Pflicht zur Bereitstellung von Daten',
  '',
  'Die Bereitstellung von Kontodaten (insbesondere E-Mail) ist für den Vertragsschluss und die Nutzung von Simple4U erforderlich. Ohne diese Daten können wir den Dienst nicht erbringen. Die Eingabe von Schüler- und Finanzdaten erfolgt freiwillig im Rahmen der Nutzung, ist aber für die jeweiligen Funktionen erforderlich.',
  '',
  '## 14. Automatisierte Entscheidungsfindung / Profiling',
  '',
  'Es findet keine automatisierte Entscheidungsfindung einschließlich Profiling im Sinne von Art. 22 DSGVO statt, die Ihnen gegenüber rechtliche Wirkung entfaltet oder Sie in ähnlicher Weise erheblich beeinträchtigt.',
  '',
  '## 15. Aktualität',
  '',
  'Wir behalten uns vor, diese Datenschutzerklärung bei Bedarf anzupassen, damit sie stets den aktuellen rechtlichen Anforderungen sowie unseren Leistungen entspricht.',
].join('\n');

const DEFAULT_LEGAL = Object.freeze({
  datenschutz: {
    title: 'Datenschutzerklärung',
    body: DATENSCHUTZ_BODY,
  },
  impressum: {
    title: 'Impressum',
    body: [
      '# Impressum',
      '',
      '## Angaben gemäß § 5 ECG / Mediengesetz (AT) bzw. einschlägiger Kennzeichnungspflichten',
      '',
      '**[Firmenname]**',
      'Anschrift: **[Anschrift]**',
      'Telefon: **[Telefon]**',
      '',
      '## Kontakt',
      'E-Mail: support@simple4u.com',
      '',
      '## Haftung für Inhalte',
      'Die Inhalte dieser Seiten wurden mit Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit und Aktualität übernehmen wir keine Gewähr.',
    ].join('\n'),
  },
});

function isLegalDocId(value) {
  return LEGAL_DOC_IDS.includes(String(value ?? '').trim());
}

/**
 * Force markdown-only storage: strip HTML tags and dangerous protocols.
 * @param {unknown} raw
 * @param {number} [maxLen]
 */
function sanitizeLegalMarkdown(raw, maxLen = 80_000) {
  let text = String(raw ?? '');
  if (text.length > maxLen) {
    text = text.slice(0, maxLen);
  }
  // Remove tags
  text = text.replace(/<[^>]*>/g, '');
  // Neutralize obvious script/url tricks in markdown links
  text = text.replace(/javascript:/gi, '');
  text = text.replace(/data:/gi, '');
  text = text.replace(/vbscript:/gi, '');
  // Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text.trim();
}

function sanitizeLegalTitle(raw, maxLen = 200) {
  return sanitizeLegalMarkdown(raw, maxLen).replace(/\n+/g, ' ').trim();
}

function defaultLegalDoc(docId) {
  return DEFAULT_LEGAL[docId] ? { ...DEFAULT_LEGAL[docId] } : null;
}

module.exports = {
  LEGAL_DOC_IDS,
  DEFAULT_LEGAL,
  isLegalDocId,
  sanitizeLegalMarkdown,
  sanitizeLegalTitle,
  defaultLegalDoc,
};

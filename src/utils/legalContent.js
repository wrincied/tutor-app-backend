/** Allowed legal CMS document ids (path-safe). */
const LEGAL_DOC_IDS = Object.freeze(['datenschutz', 'impressum']);

/**
 * Default DatenschutzerklÃ¤rung (DE) aligned with WKO checklist
 * (DSGVO Art. 13/14 + TKG Informationspflichten).
 * Operator: Arsen Mileuski (Einzelunternehmen, GISA 39994318).
 */
const DATENSCHUTZ_BODY = [
  '# DatenschutzerklÃ¤rung',
  '',
  'Der Schutz Ihrer Daten ist uns ein besonderes Anliegen. Wir verarbeiten Ihre Daten ausschlieÃŸlich auf Grundlage der gesetzlichen Bestimmungen (DSGVO, DSG, TKG). In diesen Datenschutzinformationen informieren wir Sie Ã¼ber die wichtigsten Aspekte der Datenverarbeitung im Rahmen der Website und der Anwendung **Simple4U**.',
  '',
  'Die DSGVO und das TKG beziehen sich auf personenbezogene Daten. Die IP-Adresse gilt bereits als personenbezogenes Datum. Daher mÃ¼ssen die Informationspflichten auch dann erfÃ¼llt werden, wenn bloÃŸ die IP-Adresse verarbeitet wird.',
  '',
  'Stand: August 2026',
  '',
  '## 1. Verantwortlicher',
  '',
  'Verantwortlich fÃ¼r die Datenverarbeitung:',
  '',
  '- **Arsen Mileuski** (Betreiber von Simple4U)',
  '- Anschrift: **KÃ¶flacher Gasse 9, TÃ¼r 218.2, 8020 Graz, Ã–sterreich**',
  '- Telefon: **+43 664 93290516**',
  '- E-Mail: **support@simple4u.at**',
  '',
  'Weitere Angaben finden Sie im [Impressum](/legal/impressum).',
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
  '- Browser- und GerÃ¤teinformationen (User-Agent), soweit vom Browser Ã¼bermittelt',
  '',
  'Dies ist aus technischen GrÃ¼nden zur Bereitstellung und Absicherung des Dienstes erforderlich und stellt ein berechtigtes Interesse im Sinne von Art. 6 Abs. 1 lit. f DSGVO dar. Soweit im Folgenden nichts anderes geregelt wird, werden diese Daten von uns nicht zu anderen Zwecken weiterverarbeitet.',
  '',
  '## 3. Nutzerkonto und Authentifizierung',
  '',
  'FÃ¼r die Registrierung und Anmeldung verarbeiten wir:',
  '',
  '- E-Mail-Adresse',
  '- Name (soweit angegeben)',
  '- Authentifizierungs- und Sitzungsdaten (z. B. Ã¼ber Firebase Authentication)',
  '- Einwilligungsstatus zur Datenverarbeitung und zu Marketing-Cookies (soweit erteilt)',
  '',
  '**Zweck:** Erstellung und Verwaltung Ihres Kontos, Sicherheit, VertragserfÃ¼llung.',
  '',
  '**Rechtsgrundlagen:** Art. 6 Abs. 1 lit. b DSGVO (Vertrag / vorvertragliche MaÃŸnahmen), Art. 6 Abs. 1 lit. a DSGVO (Einwilligung, soweit eingeholt), Art. 6 Abs. 1 lit. f DSGVO (Sicherheit).',
  '',
  'Ohne Angabe der erforderlichen Kontodaten ist ein Vertragsschluss bzw. die Nutzung des Dienstes nicht mÃ¶glich.',
  '',
  '## 4. CRM-Inhalte (SchÃ¼ler, Unterricht, Finanzen)',
  '',
  'Im Rahmen der Nutzung von Simple4U speichern wir die von Ihnen eingegebenen Inhalte, insbesondere:',
  '',
  '- SchÃ¼lerdaten (z. B. Name, Kontaktdaten, Notizen, Zeitzone, Tarif/Rate)',
  '- Unterrichts- und Kalenderdaten (Termine, Dauer, Status, Wiederholungen)',
  '- Finanz- und Abrechnungsdaten (Salden, Zahlungen, Ausgaben, Steuer-/Tarifeinstellungen)',
  '- optional Telegram-VerknÃ¼pfungsdaten (Chat-ID, Username), wenn Sie die Bot-Funktion aktiv nutzen',
  '',
  '**Zweck:** Bereitstellung von Terminplanung, SchÃ¼lerverwaltung und FinanzÃ¼bersicht.',
  '',
  '**Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO (VertragserfÃ¼llung).',
  '',
  'Sie entscheiden, welche Inhalte Sie eingeben. Bitte geben Sie nur Daten ein, die fÃ¼r Ihre TÃ¤tigkeit erforderlich sind.',
  '',
  '## 5. Abonnement und Zahlungsabwicklung (Stripe)',
  '',
  'FÃ¼r kostenpflichtige Abonnements (z. B. Simple4U Pro) werden ZahlungsvorgÃ¤nge Ã¼ber den Zahlungsdienstleister **Stripe** abgewickelt. Dabei kÃ¶nnen an Stripe insbesondere Daten zur Zahlungsabwicklung (z. B. Zahlungsstatus, Kunden-/Session-Referenzen) Ã¼bermittelt werden. Kartendaten werden in der Regel direkt bei Stripe verarbeitet und nicht von uns gespeichert.',
  '',
  '**Zweck:** Vertragsabwicklung, Abrechnung, BetrugsprÃ¤vention.',
  '',
  '**Rechtsgrundlagen:** Art. 6 Abs. 1 lit. b DSGVO (Vertrag), Art. 6 Abs. 1 lit. c DSGVO (gesetzliche Aufbewahrungspflichten, soweit einschlÃ¤gig), Art. 6 Abs. 1 lit. f DSGVO (BetrugsprÃ¤vention).',
  '',
  '## 6. Telegram-Benachrichtigungen',
  '',
  'Wenn Sie den Telegram-Bot mit einem SchÃ¼lerkonto verknÃ¼pfen, verarbeiten wir die dafÃ¼r erforderlichen Identifikatoren (z. B. Chat-ID, Username, VerknÃ¼pfungszeitpunkt) und senden Benachrichtigungen (z. B. Erinnerungen, Zahlungsbelege), soweit von Ihnen konfiguriert.',
  '',
  '**Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO bzw. Art. 6 Abs. 1 lit. a DSGVO (soweit eine Einwilligung der betroffenen Person erforderlich ist).',
  '',
  'Die VerknÃ¼pfung kann jederzeit getrennt werden.',
  '',
  '## 7. Cookies und Ã¤hnliche Technologien',
  '',
  'Unsere Website verwendet Cookies und vergleichbare Speichertechniken.',
  '',
  '### 7.1 Technisch erforderliche Cookies / Speicherung',
  '',
  'Erforderlich fÃ¼r Anmeldung, Sitzung, Sicherheit und grundlegende Funktionen. Ohne diese kann der Dienst nicht betrieben werden. Rechtsgrundlage: berechtigtes Interesse (Art. 6 Abs. 1 lit. f DSGVO) sowie Â§ 165 Abs. 3 TKG 2021 (technisch erforderliche Speicherung).',
  '',
  '### 7.2 Analyse / Produktverbesserung',
  '',
  'Soweit eingesetzt (z. B. Firebase Analytics), helfen diese Technologien zu verstehen, wie die Anwendung genutzt wird (z. B. welche Bildschirme hÃ¤ufiger geÃ¶ffnet werden). Daten werden nach MÃ¶glichkeit pseudonymisiert/anonymisiert. Soweit nach TKG eine Einwilligung erforderlich ist, erfolgt die Verarbeitung nur nach Ihrer Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).',
  '',
  '### 7.3 Marketing-Cookies',
  '',
  'Marketing-Cookies werden nur gesetzt, wenn Sie im Onboarding bzw. in der Cookie-Hinweiszeile aktiv zugestimmt haben (Art. 6 Abs. 1 lit. a DSGVO). Die Einwilligung kÃ¶nnen Sie jederzeit widerrufen.',
  '',
  'AusfÃ¼hrlichere Informationen: [Cookie-Richtlinie](/#/legal/cookies).',
  '',
  '## 8. EmpfÃ¤nger und Auftragsverarbeiter',
  '',
  'Wir setzen Dienstleister ein, die Daten in unserem Auftrag oder als (Mit-)Verantwortliche verarbeiten kÃ¶nnen, insbesondere:',
  '',
  '- **Google Firebase / Google Cloud** (Authentifizierung, Datenbank, Hosting/Analytics â€“ je nach Konfiguration)',
  '- **Stripe** (Zahlungsabwicklung)',
  '- **Telegram** (nur bei Nutzung der Bot-Funktion, NachrichtenÃ¼bermittlung)',
  '- ggf. Hosting-/Infrastrukturanbieter in der EU (z. B. Firebase App Hosting)',
  '',
  'Mit Auftragsverarbeitern schlieÃŸen wir â€“ soweit erforderlich â€“ VertrÃ¤ge zur Auftragsverarbeitung ab.',
  '',
  '## 9. Ãœbermittlung in DrittlÃ¤nder',
  '',
  'Einzelne Anbieter (insbesondere Google/Firebase, Stripe) kÃ¶nnen Daten in DrittlÃ¤ndern verarbeiten, insbesondere in den USA. Soweit erforderlich, stÃ¼tzen wir uns auf AngemessenheitsbeschlÃ¼sse der EuropÃ¤ischen Kommission (z. B. EU-US Data Privacy Framework, soweit anwendbar) und/oder geeignete Garantien wie Standardvertragsklauseln (SCC).',
  '',
  'NÃ¤here Informationen finden Sie in den Datenschutzhinweisen der jeweiligen Anbieter.',
  '',
  '## 10. Speicherdauer',
  '',
  '- **Kontodaten und CRM-Inhalte:** solange Ihr Konto besteht bzw. bis zur LÃ¶schung / bis Sie die LÃ¶schung verlangen, soweit keine lÃ¤ngeren gesetzlichen Aufbewahrungspflichten entgegenstehen.',
  '- **Zahlungs- und Vertragsdaten:** grundsÃ¤tzlich bis zum Ablauf steuerrechtlicher Aufbewahrungsfristen (in Ã–sterreich typischerweise bis zu 7 Jahre), soweit einschlÃ¤gig.',
  '- **Server-/Sicherheitslogs:** nur so lange, wie fÃ¼r Betrieb und Sicherheit erforderlich.',
  '- **Cookies:** je nach Art fÃ¼r die Dauer der Sitzung oder bis zum Ablauf/LÃ¶schung; Marketing-Cookies nur bei Einwilligung und gemÃ¤ÃŸ Cookie-Hinweis.',
  '',
  'Nach Abbruch einer Registrierung oder Beendigung des NutzungsverhÃ¤ltnisses lÃ¶schen bzw. anonymisieren wir Daten, soweit keine gesetzliche Pflicht zur weiteren Speicherung besteht.',
  '',
  '## 11. Ihre Rechte',
  '',
  'Ihnen stehen bezÃ¼glich Ihrer von uns verarbeiteten Daten grundsÃ¤tzlich die Rechte auf:',
  '',
  '- Auskunft (Art. 15 DSGVO)',
  '- Berichtigung (Art. 16 DSGVO)',
  '- LÃ¶schung (Art. 17 DSGVO)',
  '- EinschrÃ¤nkung der Verarbeitung (Art. 18 DSGVO)',
  '- DatenÃ¼bertragbarkeit (Art. 20 DSGVO)',
  '- Widerspruch (Art. 21 DSGVO)',
  '- Widerruf einer erteilten Einwilligung (Art. 7 Abs. 3 DSGVO) â€“ die RechtmÃ¤ÃŸigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt unberÃ¼hrt',
  '',
  'Zur AusÃ¼bung Ihrer Rechte kontaktieren Sie uns unter **support@simple4u.at**.',
  '',
  '## 12. Beschwerderecht',
  '',
  'Wenn Sie der Ansicht sind, dass die Verarbeitung Ihrer Daten gegen das Datenschutzrecht verstÃ¶ÃŸt, kÃ¶nnen Sie sich bei uns oder bei einer AufsichtsbehÃ¶rde beschweren. In Ã–sterreich ist dies insbesondere die **DatenschutzbehÃ¶rde** ([https://www.dsb.gv.at](https://www.dsb.gv.at)).',
  '',
  '## 13. Pflicht zur Bereitstellung von Daten',
  '',
  'Die Bereitstellung von Kontodaten (insbesondere E-Mail) ist fÃ¼r den Vertragsschluss und die Nutzung von Simple4U erforderlich. Ohne diese Daten kÃ¶nnen wir den Dienst nicht erbringen. Die Eingabe von SchÃ¼ler- und Finanzdaten erfolgt freiwillig im Rahmen der Nutzung, ist aber fÃ¼r die jeweiligen Funktionen erforderlich.',
  '',
  '## 14. Automatisierte Entscheidungsfindung / Profiling',
  '',
  'Es findet keine automatisierte Entscheidungsfindung einschlieÃŸlich Profiling im Sinne von Art. 22 DSGVO statt, die Ihnen gegenÃ¼ber rechtliche Wirkung entfaltet oder Sie in Ã¤hnlicher Weise erheblich beeintrÃ¤chtigt.',
  '',
  '## 15. AktualitÃ¤t',
  '',
  'Wir behalten uns vor, diese DatenschutzerklÃ¤rung bei Bedarf anzupassen, damit sie stets den aktuellen rechtlichen Anforderungen sowie unseren Leistungen entspricht.',
].join('\n');

const DEFAULT_LEGAL = Object.freeze({
  datenschutz: {
    title: 'DatenschutzerklÃ¤rung',
    body: DATENSCHUTZ_BODY,
  },
  impressum: {
    title: 'Impressum',
    body: [
      '# Impressum',
      '',
      '## Medieninhaber / Diensteanbieter',
      '',
      '**Arsen Mileuski**',
      'KÃ¶flacher Gasse 9, TÃ¼r 218.2',
      '8020 Graz, Ã–sterreich',
      '',
      '## Kontakt',
      '',
      'Telefon: +43 664 93290516',
      'E-Mail: support@simple4u.at',
      '',
      '## Gewerbe',
      '',
      'Rechtsform: Einzelunternehmen (natÃ¼rliche Person, nicht im Firmenbuch eingetragen)',
      'GewerbebehÃ¶rde / BehÃ¶rde gem. ECG: Magistrat der Stadt Graz',
      'GISA-Zahl: 39994318',
      'Gewerbe: Dienstleistungen in der automatischen Datenverarbeitung und Informationstechnik',
      'Fachgruppe: Unternehmensberatung, Buchhaltung und Informationstechnologie',
      'Berufszweig: IT-Dienstleistung',
      '',
      'Mitglied der Wirtschaftskammer Ã–sterreich (WKO), Landeskammer Steiermark',
      'Firmen Aâ€“Z: https://firmen.wko.at/arsen-mileuski/steiermark/?firmaid=7353608f-0542-4b19-b119-0dfe10e759db',
      'Anwendbare Vorschriften: Gewerbeordnung (GewO) â€” abrufbar unter https://www.ris.bka.gv.at',
      '',
      '## Offenlegung nach Â§ 25 MedienG',
      '',
      'Medieninhaber: Arsen Mileuski',
      'Unternehmensgegenstand: Bereitstellung der Web-Anwendung Simple4U (Tutor-CRM).',
      '',
      '## Haftung fÃ¼r Inhalte',
      '',
      'Die Inhalte dieser Seiten wurden mit Sorgfalt erstellt. FÃ¼r die Richtigkeit, VollstÃ¤ndigkeit und AktualitÃ¤t Ã¼bernehmen wir keine GewÃ¤hr.',
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

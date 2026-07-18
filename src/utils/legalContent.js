/** Allowed legal CMS document ids (path-safe). */
const LEGAL_DOC_IDS = Object.freeze(['datenschutz', 'impressum']);

const DEFAULT_LEGAL = Object.freeze({
  datenschutz: {
    title: 'Datenschutz',
    body: [
      '# Datenschutz',
      '',
      'Diese Richtlinie beschreibt, welche personenbezogenen Daten Simple4U verarbeitet.',
      '',
      '## Verantwortlicher',
      'Betreiber des Dienstes Simple4U. Kontakt: siehe Impressum / Kontakt.',
      '',
      '## Welche Daten wir erheben',
      'E-Mail und Name für das Konto; Schüler-, Unterrichts- und Finanzdaten, die Sie eingeben; technische Daten (Sitzung, Sprache, Fehlerprotokolle).',
      '',
      '## Zwecke',
      'Bereitstellung von Terminplaner, Schülerverwaltung und Finanzen; Sicherheit und Support; Vertragserfüllung bei Abonnements.',
      '',
      '## Ihre Rechte',
      'Sie können Auskunft, Berichtigung, Löschung oder Einschränkung verlangen und eine Einwilligung widerrufen.',
    ].join('\n'),
  },
  impressum: {
    title: 'Impressum',
    body: [
      '# Impressum',
      '',
      '## Angaben gemäß § 5 TMG',
      'Simple4U',
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

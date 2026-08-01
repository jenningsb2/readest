import { createRejectFilter } from '@/utils/node';

// Footnote reference markers rendered as link text: `1`, `[2]`, `(3)`, `*`,
// Unicode superscript digits (¹²³, ⁰-⁹), and daggers. Kept separate from the
// noteref attribute rules below so books without semantic markup still match.
const FOOTNOTE_MARKER_RE = /^[\[\(]?[*†‡\d¹²³⁰-⁹]+[\)\]]?$/;

// Node filter shared by the live TTS instance, the timeline enumeration, and
// the downloader — all MUST segment identically or timeline sentences drift
// from marks. `skipFootnotes` is a per-session choice (viewSettings.
// ttsSkipFootnotes) and must not change while a TTS session is live.
export const createTTSNodeFilter = (skipFootnotes: boolean) => {
  if (!skipFootnotes) {
    return createRejectFilter({
      tags: ['rt', 'canvas', 'br'],
      classes: ['annotationLayer'],
    });
  }
  return createRejectFilter({
    tags: ['rt', 'canvas', 'br'],
    // Footnotes/endnotes are hidden in the rendered page (see the
    // `.epubtype-footnote`/`aside[epub|type]` rules in getPageLayoutStyles);
    // skip them in TTS too, including for background sections whose
    // documents are loaded without those styles.
    classes: [
      'annotationLayer',
      'epubtype-footnote',
      'duokan-footnote-content',
      'duokan-footnote-item',
    ],
    attributeTokens: [
      {
        tag: 'aside',
        attribute: 'epub:type',
        tokens: ['footnote', 'endnote', 'note', 'rearnote'],
      },
      // Semantic footnote references: skipped whatever their text, so markers
      // like `note 1` or a lettered `a` don't get spoken mid-sentence.
      { tag: 'a', attribute: 'epub:type', tokens: ['noteref'] },
      { tag: 'a', attribute: 'role', tokens: ['doc-noteref'] },
    ],
    contents: [{ tag: 'a', content: FOOTNOTE_MARKER_RE }],
  });
};

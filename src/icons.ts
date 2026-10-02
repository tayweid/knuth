// Feather-style inline icons, Plass's system (stroke = currentColor);
// file icons are Plass's own paths so the suite reads as one hand.

export const ICONS: Record<string, string> = {
  open: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  project:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><circle cx="12" cy="14" r="2.4"/><line x1="12" y1="9.5" x2="12" y2="11.6"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  // The view switch: the file as its text, a page of lines — its own
  // glyph, so the rail's foot does not repeat the Code cell's <> above.
  source:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="8.5" y1="12.5" x2="15.5" y2="12.5"/><line x1="8.5" y1="16" x2="13" y2="16"/>',
  scratch:
    '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3.4 2.8"/><line x1="9" y1="12" x2="15" y2="12"/>',
  text: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  play: '<polygon points="7 4.5 19 12 7 19.5"/>',
  playall: '<polygon points="3.5 5 11 12 3.5 19"/><polygon points="13 5 20.5 12 13 19"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  restart: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>',
  // The session (session.ts): the pill's mark, the pin, and the kinds a
  // name can be — the round-two mockups' glyphs (docs/mockups).
  braces:
    '<path d="M8.5 3H7.5a2 2 0 0 0-2 2v4.5a2 2 0 0 1-2 2.5 2 2 0 0 1 2 2.5V19a2 2 0 0 0 2 2h1"/><path d="M15.5 3h1a2 2 0 0 1 2 2v4.5a2 2 0 0 0 2 2.5 2 2 0 0 0-2 2.5V19a2 2 0 0 1-2 2h-1"/>',
  pin: '<line x1="12" y1="15.5" x2="12" y2="22"/><path d="M8 2.5h8l-1.2 6.5 3 3.5H6.2l3-3.5z"/>',
  table: '<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="14.5" x2="21" y2="14.5"/><line x1="10" y1="5" x2="10" y2="19"/>',
  series: '<rect x="8" y="3" width="8" height="18" rx="1.5"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="15" x2="16" y2="15"/>',
  figure: '<path d="M3 3v18h18"/><polyline points="7 16 11 10 14.5 13 20 6"/>',
  value: '<circle cx="12" cy="12" r="3.4"/>',
  list: '<line x1="9" y1="7" x2="20" y2="7"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="17" x2="20" y2="17"/><line x1="4" y1="7" x2="5" y2="7"/><line x1="4" y1="12" x2="5" y2="12"/><line x1="4" y1="17" x2="5" y2="17"/>',
  fn: '<path d="M16 4h-2a3 3 0 0 0-3 3v13"/><line x1="7.5" y1="10.5" x2="15" y2="10.5"/>',
  object: '<rect x="4.5" y="4.5" width="15" height="15" rx="3.5"/><circle cx="12" cy="12" r="1.6"/>',
};

export function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

// Project and kernel SVG is untrusted. Sanitize it, then render it as an
// image-backed Blob URL so its markup never joins the application's live DOM.

import DOMPurify from 'dompurify';

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|webp);base64,/i;

function hasExternalCssReference(value: string): boolean {
  if (/@import/i.test(value)) return true;
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!match[2].trim().startsWith('#')) return true;
  }
  return false;
}

export function sanitizeSvg(svg: string): string | null {
  const purified = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'a'],
    KEEP_CONTENT: true,
  });
  const document = new DOMParser().parseFromString(purified, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName !== 'svg' || document.querySelector('parsererror')) return null;

  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) {
        element.removeAttributeNode(attribute);
      } else if (name === 'href') {
        if (value && !value.startsWith('#') && !SAFE_DATA_IMAGE.test(value)) {
          element.removeAttributeNode(attribute);
        }
      } else if (name === 'style' && hasExternalCssReference(value)) {
        element.removeAttributeNode(attribute);
      } else if (hasExternalCssReference(value)) {
        element.removeAttributeNode(attribute);
      }
    }
    if (element.localName === 'style' && hasExternalCssReference(element.textContent ?? '')) {
      element.remove();
    }
  }

  return new XMLSerializer().serializeToString(root);
}

export function createSafeSvgImage(svg: string, alt = 'Figure'): HTMLImageElement | null {
  const sanitized = sanitizeSvg(svg);
  if (!sanitized) return null;
  const url = URL.createObjectURL(new Blob([sanitized], { type: 'image/svg+xml' }));
  const image = document.createElement('img');
  image.alt = alt;
  image.decoding = 'async';
  image.draggable = false;
  image.src = url;
  image.dataset.knuthObjectUrl = url;
  return image;
}

export function clearSafeSvgImages(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[data-knuth-object-url]')) {
    const url = image.dataset.knuthObjectUrl;
    if (url) URL.revokeObjectURL(url);
  }
  root.replaceChildren();
}

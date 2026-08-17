// GitHub Pages cannot send CSP's header-only `frame-ancestors` directive.
// Refuse to initialize the app inside any frame as an additional clickjacking
// defense. A future host should still send `frame-ancestors 'none'` itself.
if (window.top !== window.self) {
  window.stop();

  const head = document.createElement('head');
  const title = document.createElement('title');
  title.textContent = 'Knuth cannot run in a frame';
  head.append(title);

  const body = document.createElement('body');
  const message = document.createElement('p');
  message.textContent = 'For your security, open Knuth directly in its own window.';
  body.append(message);
  document.documentElement.replaceChildren(head, body);

  throw new Error('Knuth refused to initialize inside a frame');
}

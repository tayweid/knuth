// The first launch of Knuth.app (APP.md): two ways to run Python, chosen
// here, installed here. The shell does the installing and reports each
// step (the Claerbout shell as `setup` events, the Swift shell through
// window.knuthSetup); this page only asks and shows. A plain script, so
// it speaks both transports itself rather than through src/shell.ts.
(function () {
  var bridge = window.claerbout;
  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.knuth;
  var shell = bridge
    ? { postMessage: function (message) { bridge.request(message); } }
    : handler;
  var status = document.getElementById('status');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button[data-python]'));
  var busy = false;

  function say(text, state) {
    status.textContent = text;
    status.className = state || '';
  }

  function choose(python) {
    if (busy || !shell) return;
    busy = true;
    buttons.forEach(function (button) {
      button.disabled = true;
      button.classList.toggle('chosen', button.dataset.python === python);
    });
    say(python === 'uv' ? 'Getting ready…' : 'Opening…', 'working');
    shell.postMessage({ type: 'choose', python: python });
  }

  window.knuthSetup = {
    progress: function (text) {
      say(text, 'working');
    },
    failed: function (text) {
      busy = false;
      buttons.forEach(function (button) {
        button.disabled = false;
        button.classList.remove('chosen');
      });
      say(text + '\nChoose again to retry.', 'failed');
    },
  };
  if (bridge) {
    bridge.on('setup', function (detail) {
      var report = window.knuthSetup[detail && detail.kind];
      if (report) report(String(detail.text));
    });
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      choose(button.dataset.python);
    });
  });

  if (!shell) {
    buttons.forEach(function (button) {
      button.disabled = true;
    });
    say('This page is part of Knuth.app.');
    return;
  }
  var wanted = new URLSearchParams(window.location.search).get('choose');
  if (wanted === 'uv' || wanted === 'browser') choose(wanted);
})();

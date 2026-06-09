(function () {
  'use strict';

  var hidden = false;

  function tryHide() {
    if (hidden) return;
    var el = document.getElementById('warning');
    if (el && el.classList.contains('warning-banner-bar')) {
      el.style.display = 'none';
      hidden = true;
    }
  }

  tryHide();

  var observer = new MutationObserver(function () {
    tryHide();
    if (hidden) observer.disconnect();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      tryHide();
      if (!hidden) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
  }

  setTimeout(function () { observer.disconnect(); }, 5000);
})();

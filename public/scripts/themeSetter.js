(function () {
  var stored = localStorage.getItem('matchouse-theme');
  document.documentElement.setAttribute('data-theme', stored === 'dark' ? 'dark' : 'light');
})();

'use strict';

(async function () {
  try {
    const response = await fetch('/api/admin/session', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const session = await response.json();
    if (!session.authenticated) return;

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/css/admin-navigation.css';
    document.head.appendChild(stylesheet);

    const pages = [
      ['/', 'Welkom'],
      ['/play', 'Spelen'],
      ['/host', 'Host'],
      ['/admin', 'Quizbeheer'],
      ['/settings', 'Instellingen']
    ];
    const currentPath = location.pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '') || '/';
    const nav = document.createElement('nav');
    nav.className = 'admin-page-navigation';
    nav.setAttribute('aria-label', 'Beheernavigatie');
    for (const [path, title] of pages) {
      const link = document.createElement('a');
      link.href = path;
      link.textContent = title;
      if (currentPath === path) link.setAttribute('aria-current', 'page');
      nav.appendChild(link);
    }
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.textContent = 'Afmelden';
    const status = document.createElement('span');
    status.hidden = true;
    status.setAttribute('role', 'alert');
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      status.hidden = true;
      try {
        const response = await fetch('/api/logout', { method: 'POST' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        location.replace('/');
      } catch (err) {
        console.error('Afmelden mislukt:', err);
        status.textContent = 'Afmelden mislukt. Controleer de verbinding en probeer opnieuw.';
        status.hidden = false;
        logout.disabled = false;
      }
    });
    nav.appendChild(logout);
    nav.appendChild(status);
    document.body.prepend(nav);
  } catch (err) {
    console.error('Beheernavigatie kon niet worden geladen:', err);
  }
})();

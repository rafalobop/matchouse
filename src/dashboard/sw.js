self.addEventListener('push', function(event) {
  if (event.data) {
    try {
      const data = event.data.json();
      const options = {
        body: data.body,
        icon: '/logo-icon', // Omitimos un icono físico duro si no existe, o usamos emoji si el navegador lo renderiza
        badge: '/logo-icon',
        vibrate: [100, 50, 100],
        data: data.data || {},
        tag: data.tag || 'housematch-notification',
        actions: [
          { action: 'open', title: 'Tocá para ver' }
        ]
      };
      event.waitUntil(
        self.registration.showNotification(data.title || 'Matchouse', options)
      );
    } catch (e) {
      console.error('Error al decodificar JSON del push:', e);
      event.waitUntil(
        self.registration.showNotification('Matchouse', {
          body: event.data.text()
        })
      );
    }
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const urlToOpen = event.notification.data.url || '/';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Si la ventana ya está abierta, hacerle focus
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url.includes(urlToOpen) && 'focus' in client) {
          return client.focus();
        }
      }
      // Si no, abrir una nueva ventana
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

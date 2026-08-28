/* Service worker for Word Summit practice-reminder notifications.
   Pushes come from the practice-reminder Supabase edge function. */
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(data.title || 'Word Summit', {
    body: data.body || 'Time for a practice round!',
    data: { url: data.url || './' },
    tag: 'word-summit-reminder'
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) return list[i].focus();
    }
    return clients.openWindow(url);
  }));
});

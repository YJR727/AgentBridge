// Service Worker：接收推送、渲染通知、处理按钮点击。
//
// 安全约束（需求里明确写了）：长期令牌绝不放进这里。
// 这里只允许出现"事件 id + 一次性 replyToken"，它只能对单个事件投一次票，泄漏面很小。
//
// 注意：这个文件以 classic script 方式注册，所以文件里不能出现 export 语句。

// 安装后立刻接管，别等下一次刷新（手机上刷新一次很麻烦）
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { title: 'Agent Bridge', body: event.data ? event.data.text() : '' };
  }

  const data = payload.data ?? {};

  // 探测消息：只在页面上广播，不打扰锁屏
  if (data.kind === 'bridge-probe') {
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const client of clients) client.postMessage({ type: 'probe', at: data.at ?? Date.now() });
      })(),
    );
    return;
  }

  const options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    renotify: Boolean(payload.renotify),
    requireInteraction: Boolean(payload.requireInteraction),
    data,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    silent: false,
  };

  // 通知按钮：只有"需要决定"的事件才带，最多按浏览器允许的个数截断
  if (Array.isArray(data.actions) && data.actions.length > 0) {
    const max = (self.Notification && self.Notification.maxActions) || 2;
    options.actions = data.actions.slice(0, max).map((a) => ({ action: a.action, title: a.title }));
  }

  event.waitUntil(self.registration.showNotification(payload.title || 'Agent Bridge', options));
});

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = notification.data ?? {};
  const action = event.action;
  notification.close();

  // 点了按钮（approve / deny）：后台直接回传，不需要打开页面
  if (action && data.replyToken && data.eventId) {
    event.waitUntil(
      (async () => {
        try {
          const res = await fetch(`/api/events/${encodeURIComponent(data.eventId)}/decision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ choice: action, via: 'notification-button', replyToken: data.replyToken }),
            credentials: 'omit',
            signal: AbortSignal.timeout(10000),
            keepalive: true,
          });
          const result = await res.json();
          if (!res.ok || !result.ok || result.decision?.choice !== action) {
            throw new Error(res.status === 409 ? '请求已处理、过期或取消' : res.status === 401 || res.status === 403 ? '授权失效，请重新配对' : '服务器未接受这次选择');
          }
          await self.registration.showNotification('选择已记录', {
            body: result.duplicate ? '相同选择已记录，无需重复提交。' : '服务已记录选择；是否执行请以电脑中的任务状态为准。',
            tag: `ack-${data.eventId}`,
            silent: true,
            icon: '/icon-192.png',
            data: { kind: 'ack' },
          });
        } catch (err) {
          await self.registration.showNotification('回传失败', {
            body: `${err.message || '网络错误'}。请打开页面查看状态。`,
            tag: `fail-${data.eventId}`,
            requireInteraction: true,
            icon: '/icon-192.png',
            data: { kind: 'ack-failed' },
          });
        }
      })(),
    );
    return;
  }

  // 点正文：聚焦已有页面或新开页面，并带上事件 id
  const target = data.threadId && data.questionId ? `/?thread=${encodeURIComponent(data.threadId)}&question=${encodeURIComponent(data.questionId)}${data.turnId?'&turn='+encodeURIComponent(data.turnId):''}` : data.eventId ? `/?event=${encodeURIComponent(data.eventId)}` : '/';
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage(data.threadId && data.questionId ? {type:'open-codex',threadId:data.threadId,questionId:data.questionId,turnId:data.turnId} : { type: 'open-event', eventId: data.eventId ?? null });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});

// 浏览器轮换订阅时，通知页面重新登记
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of list) client.postMessage({ type: 'resubscribe' });
    })(),
  );
});

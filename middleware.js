// middleware.js – Basic Auth Schutz für immoskop.ch
// Liegt im Repo-Root, wird von Vercel automatisch erkannt.
// Entfernen oder auskommentieren wenn site public geht.

export function middleware(req) {
  const basicAuth = req.headers.get('authorization');

  if (basicAuth) {
    const [scheme, encoded] = basicAuth.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = atob(encoded);
      const [user, pass] = decoded.split(':');
      // Zugangsdaten hier anpassen:
      if (user === 'ldaescher' && pass === 'Easypeazy78') {
        return; // Zugang gewährt → Request normal weiterleiten
      }
    }
  }

  // Nicht autorisiert → 401 mit WWW-Authenticate Header
  return new Response('Zugang verweigert', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Immoskop Preview"',
    },
  });
}

export const config = {
  // Alle Routen schützen ausser Vercel-interne (_vercel)
  matcher: ['/((?!_vercel|_next).*)'],
};

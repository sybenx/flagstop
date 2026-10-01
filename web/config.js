/* config.js — the one OSM app flagstop signs in through, so nobody has to register their own.

   A public OAuth 2 client (no secret: PKCE), like iD's. Register it once on osm.org (OAuth 2 applications,
   not confidential, permissions: read user preferences, modify the map) with every address flagstop runs at
   as a redirect URI, and put its client ID here. Until then, the page asks for your own app's ID as before. */
'use strict';

const FLAGSTOP_OSM = {
  clientId: '',
  // the redirect URIs the app was registered with: sign-in works from these addresses
  redirects: ['http://127.0.0.1:8765/', 'http://localhost:8765/', 'https://sybenx.github.io/flagstop/'],
};

import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  session: false,
  security: { checkOrigin: true },
  redirects: {
    '/ballots': '/policies/?status=voting',
    '/consultations': '/policies/?status=open',
    '/reviews': '/policies/',
    '/all-policies': '/policies/',
    '/pending-vote': '/policies/?status=voting',
    '/reclaim-our-economy': '/policies/',
    '/reclaim-our-future': '/policies/',
    '/governance': '/#how-it-works',
  },
});

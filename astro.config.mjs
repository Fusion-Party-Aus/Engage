import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  session: false,
  security: { checkOrigin: true },
  redirects: {
    '/policies': '/proposals/',
    '/ballots': '/proposals/?stage=decide',
    '/consultations': '/proposals/?stage=deliberate',
    '/reviews': '/proposals/',
    '/all-policies': '/proposals/',
    '/pending-vote': '/proposals/?stage=decide',
    '/reclaim-our-economy': '/proposals/',
    '/reclaim-our-future': '/proposals/',
    '/governance': '/#how-it-works',
  },
});

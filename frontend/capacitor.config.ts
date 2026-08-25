import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'it.footpredictor.personal',
  appName: 'FootPredictor',
  webDir: 'build',
  server: {
    hostname: 'localhost',
    androidScheme: 'https',
  },
  plugins: {
    CapacitorCookies: {
      enabled: true,
    },
    SystemBars: {
      insetsHandling: 'css',
      style: 'LIGHT',
      hidden: false,
    },
  },
  android: {
    backgroundColor: '#07110e',
  },
};

export default config;

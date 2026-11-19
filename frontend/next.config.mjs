export default {
  reactStrictMode: true,
  poweredByHeader: false,
  webpack(config) {
    config.resolve.alias.canvas = false;
    return config;
  },
};

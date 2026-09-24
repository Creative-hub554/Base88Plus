import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Published apps live at /p/<slug>/ (trailing slash) so their relative
  // asset URLs (styles.css, app.js) resolve inside the snapshot. Next's
  // default trailingSlash:false redirects would strip it and break them.
  trailingSlash: true,
};

export default nextConfig;

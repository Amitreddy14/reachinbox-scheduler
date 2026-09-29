/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Avatars come from Google's CDN and are rendered with a plain <img> that
  // falls back to initials, so the image optimizer is deliberately not used.
};

export default nextConfig;

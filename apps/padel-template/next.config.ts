import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // La plantilla se vende y cada club tiene su dominio. La base de datos se
  // decide en runtime por tenant, no se fija aqui.
  env: {
    NEXT_PUBLIC_APP_URL: process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000",
  },
};

export default config;

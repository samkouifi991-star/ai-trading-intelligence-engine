import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0e14",
        panel: "#12161f",
        panel2: "#181d29",
        border: "#232936",
        long: "#22c55e",
        short: "#ef4444",
        watch: "#eab308",
        accent: "#38bdf8",
      },
    },
  },
  plugins: [],
};

export default config;
